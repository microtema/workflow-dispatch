import * as core from '@actions/core';
import * as github from '@actions/github';
import {v4 as uuid} from 'uuid';
import type {GitHub} from '@actions/github/lib/utils';
import {ActionConfig, ActionOutputs, getConfig} from './action';
import {getBranchName} from './utils';

const DISTINCT_ID = uuid();
const WORKFLOW_FETCH_TIMEOUT_MS = 60 * 1000;
const WORKFLOW_JOB_STEPS_RETRY_MS = 5000;

type Octokit = InstanceType<typeof GitHub>;

let config: ActionConfig;
let octokit: Octokit;

export function init(cfg?: ActionConfig): void {
    config = cfg || getConfig();
    octokit = github.getOctokit(config.token);
}

export async function getWorkflowId(workflowFilename: string): Promise<number> {
    try {
        // https://docs.github.com/en/rest/reference/actions#list-repository-workflows
        const response = await octokit.rest.actions.listRepoWorkflows({
            owner: config.owner,
            repo: config.repo,
        });

        if (response.status !== 200) {
            throw new Error(
                `Failed to get workflows, expected 200 but received ${response.status}`
            );
        }

        const workflowId = response.data.workflows.find((workflow) =>
            new RegExp(workflowFilename).test(workflow.path)
        )?.id;

        if (workflowId === undefined) {
            throw new Error(`Unable to find ID for Workflow: ${workflowFilename}`);
        }

        return workflowId;
    } catch (error) {
        if (error instanceof Error) {
            core.error(
                `getWorkflowId: An unexpected error has occurred: ${error.message}`
            );
            error.stack && core.debug(error.stack);
        }
        throw error;
    }
}

export async function getWorkflowRunUrl(runId: number): Promise<string> {
    try {
        // https://docs.github.com/en/rest/reference/actions#get-a-workflow-run
        const response = await octokit.rest.actions.getWorkflowRun({
            owner: config.owner,
            repo: config.repo,
            run_id: runId,
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

export async function getWorkflowRunIds(workflowId: number): Promise<number[]> {
    try {
        const branchName = getBranchName(config.ref);

        // https://docs.github.com/en/rest/reference/actions#list-workflow-runs
        const response = await octokit.rest.actions.listWorkflowRuns({
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
        });

        if (response.status !== 200) {
            throw new Error(
                `Failed to get Workflow runs, expected 200 but received ${response.status}`
            );
        }

        const runIds = response.data.workflow_runs.map(
            (workflowRun) => workflowRun.id
        );

        core.debug(
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

export async function getWorkflowRunJobSteps(runId: number): Promise<string[]> {
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

        core.debug(
            "Fetched Workflow Run Job Steps:\n" +
            `  Repository: ${config.owner}/${config.repo}\n` +
            `  Workflow Run ID: ${runId}\n` +
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


export async function applyWorkflowRunId(workflowId: number): Promise<void> {

    try {
        const config = getConfig();
        const startTime = Date.now();
        init(config);

        const timeoutMs = config.workflowTimeoutSeconds * 1000;
        let attemptNo = 0;
        let elapsedTime = Date.now() - startTime;

        core.info("Attempt to extract run ID from steps...");

        while (elapsedTime < timeoutMs) {
            attemptNo++;
            elapsedTime = Date.now() - startTime;

            core.debug(`Attempting to fetch Run IDs for Workflow ID ${workflowId}`);

            // Get all runs for a given workflow ID
            const timeout = WORKFLOW_FETCH_TIMEOUT_MS > timeoutMs ? timeoutMs : WORKFLOW_FETCH_TIMEOUT_MS
            const workflowRunIds = await retryOrDie(() => getWorkflowRunIds(workflowId), timeout);

            core.debug(`Attempting to get step names for Run IDs: [${workflowRunIds}]`);

            const idRegex = new RegExp(DISTINCT_ID);

            /**
             * Attempt to read the distinct ID in the steps
             * for each existing run ID.
             */
            for (const id of workflowRunIds) {
                try {
                    const steps = await getWorkflowRunJobSteps(id);

                    for (const step of steps) {
                        if (idRegex.test(step)) {
                            const url = await getWorkflowRunUrl(id);
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
                    core.debug(`Could not identify ID in run: ${id}, continuing...`);
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