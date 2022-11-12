import * as core from '@actions/core';
import {v4 as uuid} from 'uuid';
import type {GitHub} from '@actions/github/lib/utils';
import {ActionOutputs, getNumberFromValue} from './action';
import {getBranchName} from './utils';

const DISTINCT_ID = uuid();
const WORKFLOW_FETCH_TIMEOUT_MS = 60 * 1000;
const WORKFLOW_JOB_STEPS_RETRY_MS = 5000;

const WORKFLOW_TIMEOUT_SECONDS = 5 * 60;

type Octokit = InstanceType<typeof GitHub>;

export async function getWorkflowRunUrl(runId: number, config: any, octokit: Octokit): Promise<string> {
    try {
        // https://docs.github.com/en/rest/reference/actions#get-a-workflow-run
        const response = await octokit.rest.actions.getWorkflowRun({
            owner: config.owner,
            repo: config.repo,
            run_id: runId
        });

        if (response.status !== 200) {
            throw new Error(
                `Failed to get Workflow Run state, expected 200 but received ${response.status}`
            );
        }

        core.debug(
            `Fetched Run:\n` +
            `  Repository: ${config.owner}/${config.repo}\n` +
            `  Run ID: ${runId}\n` +
            `  URL: ${response.data.html_url}`
        );

        return response.data.html_url;
    } catch (error) {
        if (error instanceof Error) {
            core.error(
                `getWorkflowRunUrl: An unexpected error has occurred: ${error.message}`
            );
            error.stack && core.debug(error.stack);
        }
        throw error;
    }
}

export async function getWorkflowRunIds(workflowId: number, config: any, octokit: Octokit): Promise<number[]> {
    try {
        const branchName = getBranchName(config.ref);
        const params = {
            owner: config.owner,
            repo: config.repo,
            workflow_id: workflowId,
            ...(branchName
                ? {
                    branch: branchName,
                    per_page: 5,
                }
                : {
                    per_page: 10,
                }),
        }

        core.info(
            "List Workflow Runs:\n" +
            `  params: ${JSON.stringify(params)}`
        );

        // https://docs.github.com/en/rest/reference/actions#list-workflow-runs
        const response = await octokit.rest.actions.listWorkflowRuns(params);

        if (response.status !== 200) {
            throw new Error(
                `Failed to get Workflow runs, expected 200 but received ${response.status}`
            );
        }

        const runIds = response.data.workflow_runs.map(
            (workflowRun) => workflowRun.id
        );

        core.info(
            "Fetched Workflow Runs:\n" +
            `  Repository: ${config.owner}/${config.repo}\n` +
            `  Branch: ${branchName || "undefined"}\n` +
            `  Workflow ID: ${workflowId}\n` +
            `  Runs Fetched: [${runIds}]`
        );

        return runIds;
    } catch (error) {
        if (error instanceof Error) {
            core.error(
                `getWorkflowRunIds: An unexpected error has occurred: ${error.message}`
            );
            error.stack && core.debug(error.stack);
        }
        throw error;
    }
}

export async function getWorkflowRunJobSteps(runId: number, config: any, octokit: Octokit): Promise<string[]> {
    try {
        // https://docs.github.com/en/rest/reference/actions#list-jobs-for-a-workflow-run
        const response = await octokit.rest.actions.listJobsForWorkflowRun({
            owner: config.owner,
            repo: config.repo,
            run_id: runId,
            filter: "latest",
        });

        if (response.status !== 200) {
            throw new Error(
                `Failed to get Workflow Run Jobs, expected 200 but received ${response.status}`
            );
        }

        const jobs = response.data.jobs.map((job) => ({
            id: job.id,
            steps: job.steps?.map((step) => step.name) || [],
        }));

        // const steps = Array.from(new Set(jobs.flatMap((job) => job.steps)));
        let allSteps: Array<string> = [];

        response.data.jobs.forEach((job) => {
            const steps = job.steps?.map((step: any) => step.name) || [];
            steps.forEach((step) => allSteps.push(step))
        });

        const steps = Array.from(new Set(allSteps))

        core.info(
            "Fetched Workflow Run Job Steps:\n" +
            `  Repository: ${config.owner}/${config.repo}\n` +
            `  Workflow Run ID: ${config.runId}\n` +
            `  Jobs Fetched: [${jobs.map((job) => job.id)}]` +
            `  Steps Fetched: [${steps}]`
        );

        return steps;
    } catch (error) {
        if (error instanceof Error) {
            core.error(`getWorkflowRunJobs: An unexpected error has occurred: ${error.message}`);
            error.stack && core.debug(error.stack);
        }
        throw error;
    }
}

/**
 * Attempt to get a non-empty array from the API.
 */
export async function retryOrDie<T>(
    retryFunc: () => Promise<T[]>,
    timeoutMs: number
): Promise<T[]> {
    const startTime = Date.now();
    let elapsedTime = 0;
    while (elapsedTime < timeoutMs) {
        elapsedTime = Date.now() - startTime;

        const response = await retryFunc();
        if (response.length > 0) {
            return response;
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    }

    throw new Error("Timed out while attempting to fetch data");
}


export async function applyWorkflowRunId(workflowId: number, config: any, octokit: Octokit): Promise<void> {

    try {
        const startTime = Date.now();

        const timeoutMs = (getNumberFromValue(config.workflowTimeoutSeconds) || WORKFLOW_TIMEOUT_SECONDS) * 1000;
        let attemptNo = 0;
        let elapsedTime = Date.now() - startTime;

        core.info("Attempt to extract run ID from steps...");

        while (elapsedTime < timeoutMs) {
            attemptNo++;
            elapsedTime = Date.now() - startTime;

            core.info(`Attempting to fetch Run IDs for Workflow ID ${config.workflowId}`);

            // Get all runs for a given workflow ID
            const timeout = WORKFLOW_FETCH_TIMEOUT_MS > timeoutMs ? timeoutMs : WORKFLOW_FETCH_TIMEOUT_MS
            const workflowRunIds = await retryOrDie(() => getWorkflowRunIds(workflowId, config, octokit), timeout);

            core.debug(`Attempting to get step names for Run IDs: [${workflowRunIds}]`);

            const idRegex = new RegExp(DISTINCT_ID);

            /**
             * Attempt to read the distinct ID in the steps
             * for each existing run ID.
             */
            for (const id of workflowRunIds) {
                try {
                    const steps = await getWorkflowRunJobSteps(id, config, octokit);

                    for (const step of steps) {
                        if (idRegex.test(step)) {
                            const url = await getWorkflowRunUrl(id, config, octokit);
                            core.info(
                                "Successfully identified remote Run:\n" +
                                `  Run ID: ${id}\n` +
                                `  URL: ${url}`
                            );
                            core.setOutput(ActionOutputs.runId, id);
                            return;
                        }
                    }
                } catch (error) {
                    if (error instanceof Error && error.message !== "Not Found") {
                        throw error;
                    }
                    core.info(`Could not identify ID in run: ${id}, continuing...`);
                }
            }

            core.info(`Exhausted searching IDs in known runs, attempt ${attemptNo}...`);

            await new Promise((resolve) => setTimeout(resolve, WORKFLOW_JOB_STEPS_RETRY_MS));
        }

        throw new Error("Timeout exceeded while attempting to get Run ID");
    } catch (error) {
        if (error instanceof Error) {
            core.error(`Failed to complete: ${error.message}`);
            core.warning("Does the token have the correct permissions?");
            error.stack && core.debug(error.stack);
            core.setFailed(error.message);
        }
    }
}
