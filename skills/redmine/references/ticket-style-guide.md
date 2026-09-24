# Redmine Ticket Style Guide

## Subject Format

```
[Component] Clear action-oriented description
```

- **Bugs**: `[Component] Error/issue when doing X`
- **Features**: `[Component] Add/implement X functionality`
- **Tasks**: `[Component] Set up/configure/migrate X`
- Platform tags when relevant: `[iOS]`, `[Android]`, `[Web]`, `[API]`
- No trailing period. Sentence case. Max ~80 chars.

## Description Templates

### Bug Report

```
h2. Context

Brief description of the issue.

h2. Steps to Reproduce

# Step 1
# Step 2
# Step 3

h2. Expected Behavior

What should happen.

h2. Actual Behavior

What actually happens.

h2. Environment

* OS:
* Browser/Device:
* Version:
```

### Feature Request

```
h2. Background

Why this feature is needed.

h2. Requirements

* Requirement 1
* Requirement 2

h2. Acceptance Criteria

* [ ] Criterion 1
* [ ] Criterion 2

h2. Out of Scope

* What is NOT included
```

### Task

```
h2. Objective

What needs to be done and why.

h2. Steps

# Step 1
# Step 2

h2. Definition of Done

* [ ] Criterion 1
* [ ] Criterion 2
```

## Notes Style

- Start with context: what was done, what was found
- Use bullet points for multiple items
- Reference related issues: `Related to #123`
- Include technical details in code blocks when relevant
- Avoid AI references, casual abbreviations, emojis

## Content Quality Checklist

Before submitting any text to Redmine:

1. **Spell-check** — fix typos and grammatical errors
2. **Clarity** — rewrite vague or ambiguous sentences
3. **Conciseness** — remove filler words, redundancy
4. **Professional tone** — no slang, casual abbreviations, or emojis
5. **Structure** — use bullet points or numbered lists for complex content
6. **English only** — translate if needed

## Subject Enhancement Examples

| User input | Enhanced |
|------------|----------|
| `fix login bug` | `[Auth] Fix login failure when password contains special characters` |
| `add btn for export` | `[Dashboard] Add export button to reports view` |
| `impl api for user` | `[API] Implement user CRUD endpoints` |
| `update db schema` | `[Database] Update user table schema for new profile fields` |
