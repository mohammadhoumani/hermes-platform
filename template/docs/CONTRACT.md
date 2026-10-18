# Contract: PROJECT NAME

<!-- Skeleton written by the template. The architect fills every section, in this order. All coders follow it exactly.
     If something is wrong or missing, coders post in the Team sync issue. They do not change this file alone. -->

## 1. Overview

Three sentences: what is built.

## 2. Assumptions

Every choice made where the BRD was silent.

## 3. Stack

Language, framework and test tools with exact versions (no `^` and no `~`). The template starts with Vite 8.3.4,
Playwright 1.64.1 and the Node test runner on Node 22.

## 4. Data model

Every stored thing, its fields and types. Say "Nothing is stored." if that is true.

## 5. API contracts

| Method and path | Purpose | Request | Response |
| --- | --- | --- | --- |
| none | No server API. Describe module interfaces below instead (function names, inputs, outputs). | | |

Details: `docs/openapi.yaml`.

## 6. Design tokens

Named variables for colours, fonts and spacing. Text must reach WCAG AA contrast (4.5:1).

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#ffffff` | Page background |
| `--text` | `#24213b` | Body text |

## 7. Folder layout

| Folder or file | Holds | Owner (task) |
| --- | --- | --- |
| `src/` | Application code and unit tests | |
| `e2e/` | Playwright end-to-end tests | |
| `docs/` | BRD, contract, plan, QA result | |

## 8. Requirement map

Every `BR-xx` and `NFR-xx` appears at least once.

| Requirement | Tasks |
| --- | --- |
| BR-01 | Task 1 |
