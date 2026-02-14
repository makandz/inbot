# Inbot

Small TypeScript app that fetches and prints all active tasks in your Todoist Inbox.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Copy the env template and add your Todoist values:

```bash
cp .env.example .env
```

Set these values in `.env`:

- `TODOIST_API_KEY`: your Todoist API token.
- `TODOIST_TARGET_PROJECT_NAME`: the project name where organized tasks will be moved.
- `TODOIST_REFERENCES_PROJECT_NAME`: the project containing read-only reference notes.
- `TODOIST_SHOPPING_PROJECT_NAME`: the project used for shopping items.
- `OPENAI_API_KEY`: your OpenAI API key.

3. Add your system prompt at `src/prompts/system.txt`.

## Run

Use development mode:

```bash
npm run dev
```

Build and run:

```bash
npm run build
npm run start
```

The app prints:

- Inbox tasks as YAML (`taskName`, `taskId`, optional `description`)
- Reference notes as YAML (from your References project)
- Shopping project name and ID (validated at startup)
- Configured project and required sections
- Required labels
- Structured GPT output for downstream processing

## Cron Example

Run every hour:

```cron
0 * * * * cd /path/to/inbot && npm run start >> /path/to/inbot/inbot.log 2>&1
```
