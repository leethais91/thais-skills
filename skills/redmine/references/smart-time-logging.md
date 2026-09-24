# Smart Time Logging

Auto-fill timesheets with minimal user input. Trigger phrase examples: "log this week", "fill timesheet for last week", "log today 4h on #1234".

## Configuration

```
MANAGEMENT_ISSUE_ID: from saved preferences (catchAllIssueId) — fallback: env REDMINE_MGMT_ISSUE_ID — else ask user once per session
TARGET_HOURS_PER_DAY: from saved preferences (timesheet.hoursPerDay) — default 8
WORK_DAYS: from saved preferences (timesheet.workDays) — default Mon–Fri
```

**Config resolution:** Check the saved preferences injected into tool descriptions (or `redmine_get_my_context`) for `catchAllIssueId` first, then env `REDMINE_MGMT_ISSUE_ID`, then prompt the user and remember for the session. The management issue is the catch-all bucket for time not directly attributable to a specific ticket (meetings, planning, mentoring, admin). When the user gives one, offer to save it via `redmine_save_preferences` so next session needs no asking.

## Supported Modes

| Command                            | Scope                       |
| ---------------------------------- | --------------------------- |
| "log this week" / "fill this week" | Current week (WORK_DAYS)    |
| "log last week"                    | Previous week (WORK_DAYS)   |
| "log this month"                   | Current month working days  |
| "log last month"                   | Previous month working days |
| "log today"                        | Today only                  |
| "log from X to Y"                  | Custom date range           |

## Flow

### Step 1: Parse scope and working days

- Determine date range from user input
- Generate list of working days (keep only WORK_DAYS)
- Ask user about holidays in that period:
  - Weekly mode: "Any holidays/days off this week?"
  - Monthly mode: "Any holidays/days off this month?"
- Remove holidays from working days list

### Step 2: Fetch existing logs

```
redmine_list_time_entries(user_id="me", from=START, to=END, limit=100)
```

- If the result says "More available. Use offset: N", call again with that offset until all entries are fetched (a month can exceed 100)
- Group by date → calculate hours already logged per day
- Skip days already >= TARGET_HOURS_PER_DAY

### Step 3: Fetch involved tickets

Gather candidate issues from both sides — the user's own tickets and the ones they created:

```
redmine_list_issues(assigned_to_id="me", status_id="open", sort="updated_on:desc", limit=15)
redmine_list_issues(author_id="me", status_id="open", sort="updated_on:desc", limit=15)
```

If one list is noisy (e.g. a PM with many assigned tickets), keep the most recently updated ones and let Step 3b trim the rest.

Also extract unique issue IDs from existing time entries in Step 2.

- Merge & deduplicate → shortlist ~5–15 tickets
- Exclude management issue from distribution pool

### Step 3b: Ask user to add/remove tickets

Show the shortlist and ask:

```
Found X tickets. Add any other ticket? (issue # or "no")
```

- User can add by issue ID: "#12345" or "12345"
- User can remove: "remove 3" (by list number)
- "no" or empty → proceed with current list

### Step 4: Fetch activity types

```
redmine_list_activities
```

Map activities for comment generation (Development, Meeting, etc.).

### Step 5: User assigns tickets to days

Show numbered ticket list and ask user to assign:

```
Tickets found:
1. #1201 Set up CI pipeline
2. #1202 Migrate build server
3. #1203 Upgrade mobile SDK
4. #1204 Prepare release 1.0.7

Working days: Mon 16, Tue 17, Wed 18 (6h logged), Thu 19, Fri 20

Assign tickets to days (format: "1: Mon-Wed 2h, 2: Thu 3h")
Or just list ticket numbers per day: "Mon: 1,2  Tue: 3  Thu-Fri: 4"
Hours auto-split equally if not specified. Remaining → management issue.
```

**Processing rules:**

1. Parse user assignments → map ticket × day × hours
2. For each day: `remaining = TARGET_HOURS_PER_DAY - existing_logged - assigned_hours`
3. If remaining > 0 → fill with management issue
4. If remaining <= 0 → done for that day
5. Round to nearest 0.5h, minimum entry: 0.5h
6. Days with no assignment and no existing logs → all TARGET_HOURS_PER_DAY to management issue

### Step 6: Generate smart comments

Auto-generate per entry based on:

- Issue subject → extract key action words
- Activity type → prefix context
- Examples:
  - `"Worked on login feature implementation"`
  - `"API endpoint development and testing"`
  - `"Team management and coordination"`

### Step 7: Preview (compact table grouped by date)

```
Smart Time Log Preview
Period: 2026-03-16 → 2026-03-20 (5 working days, 0 holidays)

Date       | Issue                    | Hours | Comment
---------- | ------------------------ | ----- | ---------------------------
Mar 16 Mon | #1234 Login feature      |  2.5h | Login bug fix and testing
           | #1235 API endpoint       |  2.5h | API development
           | #9999 Mgmt               |  3.0h | Team management
---------- | ------------------------ | ----- | ---------------------------
Mar 17 Tue | #1234 Login feature      |  2.5h | Login implementation
           | #9999 Mgmt               |  2.5h | Team management
---------- | ------------------------ | ----- | ---------------------------
Mar 18 Wed | full (8h target)         |     - |
---------- | ------------------------ | ----- | ---------------------------
Mar 19 Thu | #1234 Login feature      |  4.0h | Login feature development
           | #9999 Mgmt               |  4.0h | Team management
---------- | ------------------------ | ----- | ---------------------------
Mar 20 Fri | #1235 API endpoint       |  3.0h | API endpoint work
           | #9999 Mgmt               |  3.0h | Team management
-----------------------------------------------------------------
Summary: 4 days to fill | 27h total | 10 entries | Existing: 8h Wed
Confirm? (y/n)
```

### Step 8: User confirmation

- Show preview, ask: "Confirm to log? (y/n)"
- User can request adjustments: "move 2h from mgmt to #1234 on Monday"
- Re-preview after adjustments
- Only proceed on explicit "yes" / "y" / confirm

### Step 9: Bulk create

- Call `redmine_create_time_entry` for each entry sequentially
- Show progress: `Logging 1/11... 2/11...`
- On error: report which entry failed, continue with rest
- Final summary:

```
Done. Logged 27h across 4 days (11 entries).
0 failed.
```

## Skip & Safety Rules

- Day already >= TARGET_HOURS_PER_DAY → skip entirely
- Day would exceed TARGET_HOURS_PER_DAY after fill → warn in the preview before confirm
- Same issue already logged on the same date → do not add it silently; show the existing entry in the preview and log extra hours only if the user assigned them explicitly in Step 5
- Never overwrite or update existing entries
- Never auto-confirm — always require explicit user approval

## Natural Language Shortcuts

| User says                       | Maps to                                  |
| ------------------------------- | ---------------------------------------- |
| "log 2h on bug"                 | 2h → issues with tracker=Bug             |
| "log 3h meeting"                | 3h → management issue, activity=Meeting  |
| "log today 4h #1234, rest mgmt" | 4h → #1234, remaining → management issue |
| "fill this week"                | Same as "log this week"                  |

## Error Recovery

| Error                           | Action                                                 |
| ------------------------------- | ------------------------------------------------------ |
| No involved tickets found       | Ask user to specify issues, or log all to management   |
| Activity ID unknown             | Fetch `redmine_list_activities`, use first available   |
| Time entry creation fails       | Report error, continue with remaining entries          |
| User has no open issues         | Log all to management issue with note                  |
| No saved `catchAllIssueId` and `REDMINE_MGMT_ISSUE_ID` not set | Ask user for management issue ID, remember for session, offer to save it |
