import * as core from '@actions/core'
import type {GitHub} from '@actions/github/lib/utils'
import {getBranchName} from './utils'

const WORKFLOW_FETCH_TIMEOUT_MS = 60 * 1000
const WORKFLOW_JOB_STEPS_RETRY_MS = 5000
const WORKFLOW_TIMEOUT_SECONDS = 5 * 60

type Octokit = InstanceType<typeof GitHub>

function getNumberFromValue(value: string): number | undefined {
    if (value === "") {
        return undefined;
    }

    try {
        const num = parseInt(value);

        if (isNaN(num)) {
            throw new Error("Parsed value is NaN");
        }

        return num;
    } catch {
        throw new Error(`Unable to parse value: ${value}`);
    }
}

async function getWorkflowRunIds(workflowId: number, config: any, octokit: Octokit): Promise<number[]> {
    try {
        const branchName = getBranchName(config.ref)
        const params = {
            owner: config.owner,
            repo: config.repo,
            workflow_id: workflowId,
            ...(branchName ? {branch: branchName, per_page: 5} : {per_page: 10})
        }

        // https://docs.github.com/en/rest/reference/actions#list-workflow-runs
        const response = await octokit.rest.actions.listWorkflowRuns(params)

        if (response.status !== 200) {
            throw new Error(`Failed to get Workflow runs, expected 200 but received ${response.status}`)
        }

        const runIds = response.data.workflow_runs.map(
            (workflowRun) => workflowRun.id
        )

        core.debug(
            "Fetched Workflow Runs:\n" +
            `  Repository: ${config.owner}/${config.repo}\n` +
            `  Branch: ${branchName || "undefined"}\n` +
            `  Workflow ID: ${workflowId}\n` +
            `  Runs Fetched: [${runIds}]`
        )

        return runIds
    } catch (error) {
        if (error instanceof Error) {
            core.error(`getWorkflowRunIds: An unexpected error has occurred: ${error.message}`)
            error.stack && core.debug(error.stack)
        }
        throw error
    }
}

async function getWorkflowRunJobSteps(runId: number, config: any, octokit: Octokit): Promise<string[]> {
    try {
        // https://docs.github.com/en/rest/reference/actions#list-jobs-for-a-workflow-run
        const response = await octokit.rest.actions.listJobsForWorkflowRun({
            owner: config.owner,
            repo: config.repo,
            run_id: runId,
            filter: "latest",
        })

        if (response.status !== 200) {
            throw new Error(`Failed to get Workflow Run Jobs, expected 200 but received ${response.status}`)
        }

        const jobs = response.data.jobs.map((job) => ({
            id: job.id,
            steps: job.steps?.map((step) => step.name) || [],
        }))

        const allSteps: Array<string> = []

        response.data.jobs.forEach((job) => {
            const steps = job.steps?.map((step) => step.name) || []
            steps.forEach((step) => allSteps.push(step))
        })

        const steps = Array.from(new Set(allSteps))

        core.debug(
            "Fetched Workflow Run Job Steps:\n" +
            `  Repository: ${config.owner}/${config.repo}\n` +
            `  Workflow Run ID: ${config.runId}\n` +
            `  Jobs Fetched: [${jobs.map((job) => job.id)}]` +
            `  Steps Fetched: [${steps}]`
        )

        return steps
    } catch (error) {
        if (error instanceof Error) {
            core.error(`getWorkflowRunJobs: An unexpected error has occurred: ${error.message}`)
            error.stack && core.debug(error.stack)
        }
        throw error
    }
}

/**
 * Attempt to get a non-empty array from the API.
 */
async function retryOrDie<T>(
    retryFunc: () => Promise<T[]>,
    timeoutMs: number
): Promise<T[]> {
    const startTime = Date.now()
    let elapsedTime = 0
    while (elapsedTime < timeoutMs) {
        elapsedTime = Date.now() - startTime

        const response = await retryFunc()
        if (response.length > 0) {
            return response
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 1000))
    }

    throw new Error("Timed out while attempting to fetch data")
}

export async function applyWorkflowRunId(workflowId: number, config: any, octokit: Octokit): Promise<void> {

    try {
        const startTime = Date.now()

        const timeoutMs = (getNumberFromValue(config.workflowTimeoutSeconds) || WORKFLOW_TIMEOUT_SECONDS) * 1000
        let attemptNo = 0
        let elapsedTime = Date.now() - startTime

        core.info(`Attempt to extract run ID for Workflow ID [${workflowId}] steps filtered by UUID [${config.commitId}] ...`)

        while (elapsedTime < timeoutMs) {
            attemptNo++
            elapsedTime = Date.now() - startTime

            core.debug(`Attempting to fetch Run IDs for Workflow ID ${workflowId}`)

            // Get all runs for a given workflow ID
            const timeout = WORKFLOW_FETCH_TIMEOUT_MS > timeoutMs ? timeoutMs : WORKFLOW_FETCH_TIMEOUT_MS
            const workflowRunIds = await retryOrDie(() => getWorkflowRunIds(workflowId, config, octokit), timeout)

            core.debug(`Attempting to get step names for Run IDs: [${workflowRunIds}] filtered by [${config.commitId}]`)

            const idRegex = new RegExp(config.commitId)

            /**
             * Attempt to read the distinct ID in the steps
             * for each existing run ID.
             */
            for (const runId of workflowRunIds) {

                try {

                    const steps = await getWorkflowRunJobSteps(runId, config, octokit)

                    for (const step of steps) {

                        core.debug(
                            "Match step with idRegex:\n" +
                            `  Step: ${step}\n` +
                            `  idRegex: ${idRegex}` +
                            `  idRegex.test: ${idRegex.test(step)}`
                        )

                        if (idRegex.test(step)) {
                            core.debug(
                                "Successfully identified remote Run:\n" +
                                `  Run ID: ${runId}\n`
                            )
                            core.info(`🏆 Workflow RunId: ${runId}`)
                            core.setOutput('runId', runId)
                            return
                        }
                    }
                } catch (error) {
                    if (error instanceof Error && error.message !== "Not Found") {
                        throw error
                    }
                    core.info(`Could not identify ID in run: ${runId}, continuing...`)
                }
            }

            core.info(`Exhausted searching IDs in known runs, attempt ${attemptNo}...`)

            await new Promise((resolve) => setTimeout(resolve, WORKFLOW_JOB_STEPS_RETRY_MS))
        }

        throw new Error("Timeout exceeded while attempting to get Run ID")
    } catch (error) {
        if (error instanceof Error) {
            core.error(`Failed to complete: ${error.message}`)
            core.warning("Does the token have the correct permissions?")
            error.stack && core.debug(error.stack)
            core.setFailed(error.message)
        }
    }
}
