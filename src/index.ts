import type {
  Label,
  Section,
  Task as TodoistTask,
} from "@doist/todoist-api-typescript";
import { TodoistApi } from "@doist/todoist-api-typescript";
import "dotenv/config";
import { readFile } from "node:fs/promises";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";

const REQUIRED_SECTION_NAMES = ["waiting", "next", "later", "someday"] as const;
const REQUIRED_LABEL_NAMES = ["clarify", "quick", "errand"] as const;
const OPENAI_MODEL = "gpt-5.2";

type RequiredSectionName = (typeof REQUIRED_SECTION_NAMES)[number];
type SectionLogRecord = Record<
  RequiredSectionName,
  { id: string; name: string } | null
>;
type CompleteSectionRecord = Record<
  RequiredSectionName,
  { id: string; name: string }
>;
type RequiredLabelName = (typeof REQUIRED_LABEL_NAMES)[number];
type LabelLogRecord = Record<
  RequiredLabelName,
  { id: string; name: string } | null
>;
type CompleteLabelRecord = Record<
  RequiredLabelName,
  { id: string; name: string }
>;

const OrganizerOutputSchema = z.object({
  to_move: z.array(
    z.object({
      id: z.string(),
      section: z.enum(["no_section", "next", "later", "someday", "waiting"]),
      title: z.string().min(1),
      add_labels: z.array(z.enum(["quick", "errand"])).nullable(),
      priority: z
        .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
        .nullable(),
      description: z.string().nullable(),
    }),
  ),
  needs_clarification: z.array(
    z.object({
      id: z.string(),
      question: z.string().min(1).max(140),
    }),
  ),
});

type OrganizerOutput = z.infer<typeof OrganizerOutputSchema>;

void main();

/**
 * Runs application startup and orchestration.
 * @returns Resolves when startup work has completed.
 */
async function main(): Promise<void> {
  const todoistApiKey = getRequiredEnvVar("TODOIST_API_KEY");
  const targetProjectName = getRequiredEnvVar("TODOIST_TARGET_PROJECT_NAME");
  const openaiApiKey = getRequiredEnvVar("OPENAI_API_KEY");

  if (!todoistApiKey || !targetProjectName || !openaiApiKey) {
    process.exitCode = 1;
    return;
  }

  try {
    await run(todoistApiKey, targetProjectName, openaiApiKey);
  } catch (error: unknown) {
    console.error(formatErrorMessage(error));
    process.exitCode = 1;
  }
}

/**
 * Converts unknown thrown values to a displayable error message.
 * @param error - Unknown thrown value.
 * @returns A human-readable message.
 */
function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected error while starting the app.";
}

/**
 * Gets and validates a required environment variable.
 * @param variableName - Name of the environment variable.
 * @returns The variable value when present; otherwise undefined.
 */
function getRequiredEnvVar(variableName: string): string | undefined {
  const value = process.env[variableName];

  if (!value) {
    console.error(`Missing ${variableName}. Add it to your .env file.`);
    return undefined;
  }

  return value;
}

/**
 * Fetches inbox tasks and target project details from Todoist.
 * @param apiKey - Todoist API token.
 * @param projectName - Name of the project where organized tasks will be placed.
 * @param openaiApiKey - OpenAI API key used for task organization output.
 * @returns Resolves when all task and project details have been printed.
 */
async function run(
  apiKey: string,
  projectName: string,
  openaiApiKey: string,
): Promise<void> {
  const api = new TodoistApi(apiKey);

  const projectsResponse = await api.getProjects();
  const inboxProject = projectsResponse.results.find(
    (project) => "inboxProject" in project && project.inboxProject,
  );

  if (!inboxProject) {
    throw new Error("Could not find an inbox project for this user");
  }

  const targetProject = projectsResponse.results.find(
    (project) => project.name.toLowerCase() === projectName.toLowerCase(),
  );

  if (!targetProject) {
    throw new Error(`Could not find project named "${projectName}"`);
  }

  const tasksResponse = await api.getTasks({ projectId: inboxProject.id });
  const inboxTaskRecord = buildInboxTaskRecord(tasksResponse.results);
  const inboxTasksYaml = stringifyYaml(inboxTaskRecord);

  console.log("Inbox tasks:");
  console.log(inboxTasksYaml);

  const sectionsResponse = await api.getSections({
    projectId: targetProject.id,
  });
  const sectionRecord = buildSectionRecord(sectionsResponse.results);
  assertRequiredSectionsExist(sectionRecord);

  console.log("");
  console.log(`Project: ${targetProject.name} (${targetProject.id})`);
  console.log("Tracked sections:");

  REQUIRED_SECTION_NAMES.forEach((sectionName) => {
    const section = sectionRecord[sectionName];
    console.log(`Section: ${section.name} (${section.id})`);
  });

  console.log("Section record:");
  console.log(JSON.stringify(sectionRecord, null, 2));

  const labelsResponse = await api.getLabels();
  const labelRecord = buildLabelRecord(labelsResponse.results);
  assertRequiredLabelsExist(labelRecord);

  console.log("");
  console.log("Tracked labels:");

  REQUIRED_LABEL_NAMES.forEach((labelName) => {
    const label = labelRecord[labelName];
    console.log(`Label: ${label.name} (${label.id})`);
  });

  console.log("Label record:");
  console.log(JSON.stringify(labelRecord, null, 2));

  const systemPrompt = await loadSystemPrompt();
  const organizerOutput = await requestTaskOrganization(
    openaiApiKey,
    systemPrompt,
    inboxTasksYaml,
  );

  console.log("");
  console.log("LLM structured output:");
  console.log(JSON.stringify(organizerOutput, null, 2));
}

/**
 * Loads the system prompt text from a fixed prompt file.
 * @returns Prompt contents ready to be sent as model instructions.
 */
async function loadSystemPrompt(): Promise<string> {
  const promptPath = "src/prompts/system.txt";
  let prompt: string;

  try {
    prompt = await readFile(promptPath, "utf8");
  } catch {
    throw new Error(`Missing prompt file at ${promptPath}.`);
  }

  if (prompt.trim().length === 0) {
    throw new Error(`Prompt file at ${promptPath} is empty.`);
  }

  return prompt;
}

/**
 * Sends inbox YAML to OpenAI and parses a structured organizer output.
 * @param openaiApiKey - OpenAI API key.
 * @param systemPrompt - System prompt text.
 * @param inboxTasksYaml - YAML representation of inbox tasks.
 * @returns Structured output from the model.
 */
async function requestTaskOrganization(
  openaiApiKey: string,
  systemPrompt: string,
  inboxTasksYaml: string,
): Promise<OrganizerOutput> {
  const openaiClient = new OpenAI({ apiKey: openaiApiKey });

  const response = await openaiClient.responses.parse({
    model: OPENAI_MODEL,
    instructions: systemPrompt,
    input: `Inbox task list in YAML:\n\n${inboxTasksYaml}`,
    text: {
      format: zodTextFormat(OrganizerOutputSchema, "inbox_organization_output"),
    },
  });

  if (!response.output_parsed) {
    throw new Error("OpenAI response did not include structured output.");
  }

  return response.output_parsed;
}

/**
 * Builds a record of only the required organization sections.
 * @param sections - All sections returned for the target project.
 * @returns A record keyed by required section name with section IDs when found.
 */
function buildSectionRecord(sections: Section[]): SectionLogRecord {
  const record: SectionLogRecord = {
    waiting: null,
    next: null,
    later: null,
    someday: null,
  };

  sections.forEach((section) => {
    const normalizedName = section.name.toLowerCase() as RequiredSectionName;

    if (!REQUIRED_SECTION_NAMES.includes(normalizedName)) {
      return;
    }

    record[normalizedName] = {
      id: section.id,
      name: section.name,
    };
  });

  return record;
}

/**
 * Ensures all required sections are present in the target project.
 * @param sectionRecord - Record of required section names and matched section data.
 * @returns Nothing; throws an error when one or more sections are missing.
 */
function assertRequiredSectionsExist(
  sectionRecord: SectionLogRecord,
): asserts sectionRecord is CompleteSectionRecord {
  const missingSections = REQUIRED_SECTION_NAMES.filter(
    (sectionName) => sectionRecord[sectionName] === null,
  );

  if (missingSections.length === 0) {
    return;
  }

  throw new Error(
    `Missing required sections in target project: ${missingSections.join(", ")}`,
  );
}

/**
 * Builds a record of only the required organization labels.
 * @param labels - All labels returned for the user.
 * @returns A record keyed by required label name with label IDs when found.
 */
function buildLabelRecord(labels: Label[]): LabelLogRecord {
  const record: LabelLogRecord = {
    clarify: null,
    quick: null,
    errand: null,
  };

  labels.forEach((label) => {
    const normalizedName = label.name.toLowerCase() as RequiredLabelName;

    if (!REQUIRED_LABEL_NAMES.includes(normalizedName)) {
      return;
    }

    record[normalizedName] = {
      id: label.id,
      name: label.name,
    };
  });

  return record;
}

/**
 * Ensures all required labels are present for the user.
 * @param labelRecord - Record of required label names and matched label data.
 * @returns Nothing; throws an error when one or more labels are missing.
 */
function assertRequiredLabelsExist(
  labelRecord: LabelLogRecord,
): asserts labelRecord is CompleteLabelRecord {
  const missingLabels = REQUIRED_LABEL_NAMES.filter(
    (labelName) => labelRecord[labelName] === null,
  );

  if (missingLabels.length === 0) {
    return;
  }

  throw new Error(`Missing required labels: ${missingLabels.join(", ")}`);
}

/**
 * Builds JSON-safe inbox task output.
 * @param tasks - Active tasks in the user's inbox project.
 * @returns A JSON object containing task name, ID, and optional description.
 */
function buildInboxTaskRecord(tasks: TodoistTask[]): {
  tasks: Array<{ taskName: string; taskId: string; description?: string }>;
} {
  return {
    tasks: tasks.map((task) => {
      const baseTask = {
        taskName: task.content,
        taskId: task.id,
      };

      if (!task.description || task.description.trim().length === 0) {
        return baseTask;
      }

      return {
        ...baseTask,
        description: task.description,
      };
    }),
  };
}
