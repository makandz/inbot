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

The app prints one line per Inbox task, then prints the configured target project and all of its sections with IDs.

## Cron Example

Run every hour:

```cron
0 * * * * cd /path/to/inbot && npm run start >> /path/to/inbot/inbot.log 2>&1
```
