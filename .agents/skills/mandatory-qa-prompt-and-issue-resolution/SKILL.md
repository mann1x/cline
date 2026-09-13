# Rule: Mandatory QA Prompt & Issue Resolution Flow

Whenever you modify, create, or delete any code or configuration file in the project, you must manage post-change validation using the following two-stage process.

---

## Stage 1: QA Process Execution

Unless "QA Always" mode is active, ask the user:
> "Would you like to run the QA process on this change?"
> 1: Yes
> 2: No
> 3: Always

### Stage 1 Action Matrix
* **Choice 1 (Yes):** 
  1. Formulate a tailored QA plan (e.g., unit tests, type checks, linting, CLI validation).
  2. Implement and execute the QA plan.
  3. Compile all test outputs into a **QA Report**.
  4. Proceed immediately to **Stage 2**.
* **Choice 2 (No):** Skip QA and proceed with normal task execution.
* **Choice 3 (Always):** Flag `QA_ALWAYS = true` for the session. Execute the QA plan, generate the QA Report, and proceed directly to **Stage 2** without prompting Stage 1 in subsequent edits.

---

## Stage 2: Issue Resolution Flow

Evaluate the generated **QA Report**:
* **If No Issues Found:** Report clean status to the user and continue normal workflow.
* **If Issues Found:** 
  * If `FIX_ALWAYS = true`, automatically fix all identified issues.
  * Otherwise, present the issues summary and ask the user:
    > "Issues were detected during QA. Would you like me to fix them?"
    > 1: Yes
    > 2: No
    > 3: Always

### Stage 2 Action Matrix
* **Choice 1 (Yes):** Plan and implement fixes for all identified issues, then re-run the QA plan to confirm resolution.
* **Choice 2 (No):** Do not modify any code. Leave the existing changes and QA findings as-is.
* **Choice 3 (Always):** Flag `FIX_ALWAYS = true` for the session. Fix all current issues immediately, and automatically fix any future QA failures without asking.

---

## Session State Flags
Maintain two independent flags during the session context:
- `QA_ALWAYS`: Bypasses Stage 1 prompt.
- `FIX_ALWAYS`: Bypasses Stage 2 prompt when errors exist.