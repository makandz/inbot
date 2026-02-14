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
const APP_TITLE = `|._ |_  _ _|_
|| ||_)(_) | 
Todoist Organizer`;

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
  shopping: z.array(
    z.object({
      id: z.string(),
      title: z.string().min(1),
    }),
  ),
});

type OrganizerOutput = z.infer<typeof OrganizerOutputSchema>;
type OrganizerSection = OrganizerOutput["to_move"][number]["section"];

type OrganizerApplyArgs = {
  api: TodoistApi;
  organizerOutput: OrganizerOutput;
  actionableInboxTasks: TodoistTask[];
  targetProjectId: string;
  shoppingProjectId: string;
  sectionRecord: CompleteSectionRecord;
  clarifyLabelName: string;
};

void main();

/**
 * Runs application startup and orchestration.
 * @returns Resolves when startup work has completed.
 */
async function main(): Promise<void> {
  console.log(APP_TITLE);
  console.log("");

  const todoistApiKey = getRequiredEnvVar("TODOIST_API_KEY");
  const targetProjectName = getRequiredEnvVar("TODOIST_TARGET_PROJECT_NAME");
  const referencesProjectName = getRequiredEnvVar("TODOIST_REFERENCES_PROJECT_NAME");
  const shoppingProjectName = getRequiredEnvVar("TODOIST_SHOPPING_PROJECT_NAME");
  const openaiApiKey = getRequiredEnvVar("OPENAI_API_KEY");

  if (
    !todoistApiKey ||
    !targetProjectName ||
    !referencesProjectName ||
    !shoppingProjectName ||
    !openaiApiKey
  ) {
    process.exitCode = 1;
    return;
  }

  try {
    await run(
      todoistApiKey,
      targetProjectName,
      referencesProjectName,
      shoppingProjectName,
      openaiApiKey,
    );
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
 * @param referencesProjectName - Name of the read-only references project.
 * @param shoppingProjectName - Name of the shopping project used for shopping tasks.
 * @param openaiApiKey - OpenAI API key used for task organization output.
 * @returns Resolves when all task and project details have been printed.
 */
async function run(
  apiKey: string,
  projectName: string,
  referencesProjectName: string,
  shoppingProjectName: string,
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

  const referencesProject = projectsResponse.results.find(
    (project) => project.name.toLowerCase() === referencesProjectName.toLowerCase(),
  );

  if (!referencesProject) {
    throw new Error(`Could not find project named "${referencesProjectName}"`);
  }

  const shoppingProject = projectsResponse.results.find(
    (project) => project.name.toLowerCase() === shoppingProjectName.toLowerCase(),
  );

  if (!shoppingProject) {
    throw new Error(`Could not find project named "${shoppingProjectName}"`);
  }

  const shoppingProjectId = shoppingProject.id;

  const sectionsResponse = await api.getSections({
    projectId: targetProject.id,
  });
  const sectionRecord = buildSectionRecord(sectionsResponse.results);
  assertRequiredSectionsExist(sectionRecord);

  const labelsResponse = await api.getLabels();
  const labelRecord = buildLabelRecord(labelsResponse.results);
  assertRequiredLabelsExist(labelRecord);

  console.log("Loaded projects, sections, and labels.");

  const referencesTasksResponse = await api.getTasks({
    projectId: referencesProject.id,
  });
  const referenceNotesRecord = buildReferenceNotesRecord(referencesTasksResponse.results);
  const referencesYaml = stringifyYaml(referenceNotesRecord);
  console.log(`Loaded ${referenceNotesRecord.reference_notes.length} references.`);

  const tasksResponse = await api.getTasks({ projectId: inboxProject.id });
  const actionableInboxTasks = tasksResponse.results.filter(
    (task) => !hasLabel(task, labelRecord.clarify.name),
  );
  const inboxTaskRecord = buildInboxTaskRecord(actionableInboxTasks);
  const inboxTasksYaml = stringifyYaml(inboxTaskRecord);

  console.log(`Loaded ${actionableInboxTasks.length} inbox tasks.`);

  if (actionableInboxTasks.length === 0) {
    console.log("No actionable inbox tasks found.");
    return;
  }

  console.log("Inbox task IDs:");
  console.log(formatTaskIdList(actionableInboxTasks.map((task) => task.id)));

  const systemPrompt = await loadSystemPrompt();
  console.log("Sending request to GPT...");
  const organizerOutput = await requestTaskOrganization(
    openaiApiKey,
    systemPrompt,
    referencesYaml,
    inboxTasksYaml,
  );

  console.log("Response received, parsing and processing...");

  await applyOrganizerOutput({
    api,
    organizerOutput,
    actionableInboxTasks,
    targetProjectId: targetProject.id,
    shoppingProjectId,
    sectionRecord,
    clarifyLabelName: labelRecord.clarify.name,
  });
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
 * @param referencesYaml - YAML representation of reference notes.
 * @param inboxTasksYaml - YAML representation of inbox tasks.
 * @returns Structured output from the model.
 */
async function requestTaskOrganization(
  openaiApiKey: string,
  systemPrompt: string,
  referencesYaml: string,
  inboxTasksYaml: string,
): Promise<OrganizerOutput> {
  const openaiClient = new OpenAI({ apiKey: openaiApiKey });

  const response = await openaiClient.responses.parse({
    model: OPENAI_MODEL,
    instructions: systemPrompt,
    input: `Reference notes in YAML:\n\n${referencesYaml}\n\nInbox task list in YAML:\n\n${inboxTasksYaml}`,
    text: {
      format: zodTextFormat(OrganizerOutputSchema, "inbox_organization_output"),
    },
  });

  if (!response.output_parsed) {
    throw new Error("OpenAI response did not include structured output.");
  }

  return OrganizerOutputSchema.parse(response.output_parsed);
}

/**
 * Applies the parsed organizer output by modifying existing Todoist tasks.
 * @param args - Inputs required to apply model output safely.
 * @returns Resolves when all requested task updates have been applied.
 */
async function applyOrganizerOutput(args: OrganizerApplyArgs): Promise<void> {
  const {
    api,
    organizerOutput,
    actionableInboxTasks,
    targetProjectId,
    shoppingProjectId,
    sectionRecord,
    clarifyLabelName,
  } = args;

  const taskMap = new Map(actionableInboxTasks.map((task) => [task.id, task]));

  validateOrganizerOutput(organizerOutput, taskMap);

  console.log(
    `Applying actions: ${organizerOutput.to_move.length} to_move, ${organizerOutput.shopping.length} shopping, ${organizerOutput.needs_clarification.length} clarification.`,
  );

  for (const toMoveTask of organizerOutput.to_move) {
    const task = getTaskFromMap(taskMap, toMoveTask.id);
    await applyToMoveAction({
      api,
      task,
      toMoveTask,
      targetProjectId,
      sectionRecord,
    });
  }

  for (const shoppingTask of organizerOutput.shopping) {
    const task = getTaskFromMap(taskMap, shoppingTask.id);
    await applyShoppingAction({
      api,
      task,
      shoppingTask,
      shoppingProjectId,
    });
  }

  for (const clarificationTask of organizerOutput.needs_clarification) {
    const task = getTaskFromMap(taskMap, clarificationTask.id);
    await applyClarificationAction({
      api,
      task,
      clarificationTask,
      clarifyLabelName,
    });
  }

  console.log("All tasks moved!");
}

/**
 * Validates model output task coverage before mutating Todoist data.
 * @param organizerOutput - Structured response from the model.
 * @param taskMap - Actionable inbox task map keyed by task ID.
 * @returns Nothing; throws on duplicate, unknown, or missing task IDs.
 */
function validateOrganizerOutput(
  organizerOutput: OrganizerOutput,
  taskMap: Map<string, TodoistTask>,
): void {
  const allIds = [
    ...organizerOutput.to_move.map((task) => task.id),
    ...organizerOutput.shopping.map((task) => task.id),
    ...organizerOutput.needs_clarification.map((task) => task.id),
  ];

  const duplicateIds = allIds.filter((id, index) => allIds.indexOf(id) !== index);
  if (duplicateIds.length > 0) {
    throw new Error(
      `OpenAI response contains duplicate task IDs: ${Array.from(new Set(duplicateIds)).join(", ")}`,
    );
  }

  const unknownIds = allIds.filter((id) => !taskMap.has(id));
  if (unknownIds.length > 0) {
    throw new Error(
      `OpenAI response contains unknown task IDs: ${Array.from(new Set(unknownIds)).join(", ")}`,
    );
  }

  if (allIds.length !== taskMap.size) {
    const assignedIds = new Set(allIds);
    const missingIds = Array.from(taskMap.keys()).filter((id) => !assignedIds.has(id));
    throw new Error(
      `OpenAI response did not cover all actionable inbox tasks. Missing IDs: ${missingIds.join(", ")}`,
    );
  }
}

/**
 * Returns a task by ID from the actionable inbox task map.
 * @param taskMap - Actionable inbox tasks keyed by ID.
 * @param taskId - Task ID to resolve.
 * @returns The matching task.
 */
function getTaskFromMap(taskMap: Map<string, TodoistTask>, taskId: string): TodoistTask {
  const task = taskMap.get(taskId);

  if (!task) {
    throw new Error(`Task ID ${taskId} was not found in actionable inbox tasks.`);
  }

  return task;
}

/**
 * Applies a `to_move` task mutation.
 * @param args - Data required to move and update a task.
 * @returns Resolves when move, update, and audit comment are complete.
 */
async function applyToMoveAction(args: {
  api: TodoistApi;
  task: TodoistTask;
  toMoveTask: OrganizerOutput["to_move"][number];
  targetProjectId: string;
  sectionRecord: CompleteSectionRecord;
}): Promise<void> {
  const { api, task, toMoveTask, targetProjectId, sectionRecord } = args;

  const finalSection = resolveFinalSection(task, toMoveTask.section);
  const labelsToAdd = toMoveTask.add_labels ?? [];
  const mergedLabels = mergeLabels(task.labels, labelsToAdd);

  console.log(`Moving task ID ${task.id} to ${finalSection}.`);

  if (finalSection === "no_section") {
    await api.moveTask(task.id, { projectId: targetProjectId });
  } else {
    await api.moveTask(task.id, { sectionId: sectionRecord[finalSection].id });
  }

  await api.updateTask(task.id, {
    content: toMoveTask.title,
    description: toMoveTask.description ?? "",
    labels: mergedLabels,
    ...(toMoveTask.priority !== null ? { priority: toMoveTask.priority } : {}),
  });

  await api.addComment({
    taskId: task.id,
    content: buildToMoveAuditComment(task, finalSection, labelsToAdd, toMoveTask.priority),
  });
}

/**
 * Applies a `shopping` task mutation.
 * @param args - Data required to move and update a shopping task.
 * @returns Resolves when move, update, and audit comment are complete.
 */
async function applyShoppingAction(args: {
  api: TodoistApi;
  task: TodoistTask;
  shoppingTask: OrganizerOutput["shopping"][number];
  shoppingProjectId: string;
}): Promise<void> {
  const { api, task, shoppingTask, shoppingProjectId } = args;
  const shoppingTitle = capitalizeFirstLetter(shoppingTask.title.trim());

  console.log(`Moving task ID ${task.id} to shopping project.`);

  await api.moveTask(task.id, { projectId: shoppingProjectId });
  await api.updateTask(task.id, { content: shoppingTitle });

  await api.addComment({
    taskId: task.id,
    content: buildShoppingAuditComment(task),
  });
}

/**
 * Applies a `needs_clarification` task mutation.
 * @param args - Data required to label and comment a clarification task.
 * @returns Resolves when updates and comment are complete.
 */
async function applyClarificationAction(args: {
  api: TodoistApi;
  task: TodoistTask;
  clarificationTask: OrganizerOutput["needs_clarification"][number];
  clarifyLabelName: string;
}): Promise<void> {
  const { api, task, clarificationTask, clarifyLabelName } = args;
  const mergedLabels = mergeLabels(task.labels, [clarifyLabelName]);

  console.log(`Requesting clarification for task ID ${task.id}.`);

  await api.updateTask(task.id, { labels: mergedLabels });

  await api.addComment({
    taskId: task.id,
    content: buildClarificationComment(task, clarifyLabelName, clarificationTask.question),
  });
}

/**
 * Resolves the final section for a task based on due-date rules.
 * @param task - Current Todoist task state.
 * @param requestedSection - Section requested by model output.
 * @returns The final section that should be applied.
 */
function resolveFinalSection(task: TodoistTask, requestedSection: OrganizerSection): OrganizerSection {
  if (task.due) {
    return "no_section";
  }

  return requestedSection;
}

/**
 * Merges labels while preserving existing labels and preventing duplicates.
 * @param existingLabels - Labels currently on the task.
 * @param labelsToAdd - Labels that should be added.
 * @returns A deduplicated label array for task updates.
 */
function mergeLabels(existingLabels: string[], labelsToAdd: string[]): string[] {
  const mergedLabels = [...existingLabels];
  const existingLabelSet = new Set(existingLabels.map((label) => label.toLowerCase()));

  labelsToAdd.forEach((label) => {
    const normalizedLabel = label.toLowerCase();

    if (existingLabelSet.has(normalizedLabel)) {
      return;
    }

    mergedLabels.push(label);
    existingLabelSet.add(normalizedLabel);
  });

  return mergedLabels;
}

/**
 * Checks whether a task currently has a given label.
 * @param task - Todoist task to inspect.
 * @param labelName - Label name to check for.
 * @returns True when the label already exists on the task.
 */
function hasLabel(task: TodoistTask, labelName: string): boolean {
  return task.labels.some((label) => label.toLowerCase() === labelName.toLowerCase());
}

/**
 * Creates an audit comment for `to_move` mutations.
 * @param task - Original task before updates.
 * @param finalSection - Section selected after due-date override rules.
 * @param labelsToAdd - Labels requested to be added.
 * @param priority - Priority requested by model output.
 * @returns Comment body for Todoist.
 */
function buildToMoveAuditComment(
  task: TodoistTask,
  finalSection: OrganizerSection,
  labelsToAdd: string[],
  priority: 1 | 2 | 3 | 4 | null,
): string {
  const labelsSummary = labelsToAdd.length > 0 ? labelsToAdd.join(", ") : "none";
  const prioritySummary = priority === null ? "none" : String(priority);

  return buildAuditComment([
    ["Old title", task.content],
    ["Old description", formatDescription(task.description)],
    ["Moved section", finalSection],
    ["Labels added", labelsSummary],
    ["Priority assigned", prioritySummary],
  ]);
}

/**
 * Creates an audit comment for shopping task mutations.
 * @param task - Original task before updates.
 * @returns Comment body for Todoist.
 */
function buildShoppingAuditComment(task: TodoistTask): string {
  return buildAuditComment([
    ["Old title", task.content],
    ["Old description", formatDescription(task.description)],
    ["Moved section", "no_section"],
    ["Labels added", "none"],
    ["Priority assigned", "none"],
  ]);
}

/**
 * Creates a clarification comment that includes audit details.
 * @param task - Original task before updates.
 * @param clarifyLabelName - Clarify label name that was applied.
 * @param question - Clarification question generated by the model.
 * @returns Comment body for Todoist.
 */
function buildClarificationComment(
  task: TodoistTask,
  clarifyLabelName: string,
  question: string,
): string {
  return [
    buildAuditComment([
      ["Old title", task.content],
      ["Old description", formatDescription(task.description)],
      ["Moved section", "unchanged"],
      ["Labels added", clarifyLabelName],
      ["Priority assigned", "none"],
    ]),
    `**Clarification needed**: ${question}`,
  ].join("\n\n");
}

/**
 * Builds a standardized audit comment body.
 * @param details - Key/value detail lines to include after the header.
 * @returns Formatted audit comment text.
 */
function buildAuditComment(details: Array<[string, string]>): string {
  const detailLines = details.map(([key, value]) => `**${key}**: ${value}`);

  return ["Organized!", "", ...detailLines].join("\n");
}

/**
 * Formats task descriptions for audit comment readability.
 * @param description - Task description from Todoist.
 * @returns A printable description value.
 */
function formatDescription(description: string): string {
  if (description.trim().length === 0) {
    return "(empty)";
  }

  return description;
}

/**
 * Capitalizes the first character in a string.
 * @param value - Source value.
 * @returns Value with an uppercase first character.
 */
function capitalizeFirstLetter(value: string): string {
  if (value.length === 0) {
    return value;
  }

  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Formats task IDs as a multi-line list.
 * @param ids - Task IDs to include in logs.
 * @returns A bullet-style ID list.
 */
function formatTaskIdList(ids: string[]): string {
  if (ids.length === 0) {
    return "none";
  }

  return ids.map((id) => `- ${id}`).join("\n");
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

/**
 * Builds YAML-safe reference notes payload from project tasks.
 * @param tasks - Active tasks from the references project.
 * @returns A record containing reference note titles.
 */
function buildReferenceNotesRecord(tasks: TodoistTask[]): {
  reference_notes: Array<{ title: string }>;
} {
  return {
    reference_notes: tasks.map((task) => ({
      title: task.content,
    })),
  };
}
