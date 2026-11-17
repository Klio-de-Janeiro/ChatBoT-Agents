# Plan construction

Read the local project's `CONTRACT.md` if the CLI schema changes. The repository includes runnable templates in `examples/notebook.plan.json` and `examples/markdown.plan.json`. The backend resolves relative output paths against the **plan file's directory**; prefer an absolute output path in a generated plan.

```json
{
  "task_id": "linear-regression-001",
  "objective": "Create a Russian learning notebook about linear regression.",
  "jobs": [
    {"id":"theory","provider":"deepseek","prompt":"Write definitions, assumptions, derivation and a small worked example.","depends_on":[],"timeout":180},
    {"id":"practice","provider":"qwen","prompt":"Write a reproducible NumPy example, checks and explanation. Do not run code.","depends_on":[],"timeout":180}
  ],
  "editor": {
    "provider":"qwen",
    "prompt":"Review every author output for correctness and consistency. Correct errors, combine them into a coherent Russian notebook and check all formulas and code by reasoning. Return only a JSON object {\"cells\":[{\"cell_type\":\"markdown\",\"source\":\"...\"},{\"cell_type\":\"code\",\"source\":\"...\"}]}. Use strings for source, no outputs, no execution counters, no surrounding prose.",
    "timeout":300
  },
  "output":{"format":"ipynb","path":"C:\\absolute\\linear-regression.ipynb"}
}
```

`task_id` must be a safe path component and should identify a new submission. Job IDs must be unique. `depends_on` names existing jobs; dependencies form a directed acyclic graph. Timeouts are seconds. Author prompts describe their bounded work; the editor prompt requests review of **all** content and the exact cells schema. An editor conversation is distinct even if it shares a provider with an author.

For `output.format = "markdown"`, keep the cells JSON response contract and ask the editor for Markdown cells only. The backend renders those cells to the Markdown output. Generated notebook code is never executed by this workflow.

Do not pre-read outputs to construct a later prompt: dependency and editor context are assembled inside the backend. The backend may request at most one formatting repair from the editor; malformed output remains a failure, with the raw response retained for the user.
