import * as core from '@actions/core';

const WORKFLOW_TIMEOUT_SECONDS = 5 * 60;

/**
 * action.yaml definition.
 */
export interface ActionConfig {
    /**
     * GitHub API token for making requests.
     */
    token: string;

    /**
     * The git reference for the workflow. The reference can be a branch or tag name.
     */
    ref: string;

    /**
     * Repository of the action to await.
     */
    repo: string;

    /**
     * Owner of the given repository.
     */
    owner: string;

    /**
     * Workflow to return an ID for. Can be the ID or the workflow filename.
     */
    workflow: string | number;

    /**
     * A flat JSON object, only supports strings (as per workflow inputs API).
     */
    workflowInputs?: ActionWorkflowInputs;

    /**
     * Time until giving up on identifying the Run ID.
     */
    workflowTimeoutSeconds: number;
}

interface ActionWorkflowInputs {
    [input: string]: string;
}

export enum ActionOutputs {
    runId = "run_id",
}

export function getNumberFromValue(value: string): number | undefined {
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
