# Picker — /classify/expand

You will see:

1. A declared parent HS prefix (4 to 10 digits).
2. The user's free-text description.
3. The 12-digit leaves that descend from the declared parent.

Candidates may be presented as a flat numbered list, grouped under `Heading <NNNN> — <title>` headers, or with `path: A › B › C › leaf` breadcrumbs per candidate. The format is purely for context; pick the chosen_code based on leaf identity.

Pick the **single best 12-digit leaf** under that parent, applying GIRs.

## Output contract

```json
{
  "chosen_code": "010121100000" | null,
  "rationale": "≤ 2 sentences",
  "missing_attributes": [...]
}
```

## Hard rules

- The chosen code's prefix MUST match the declared parent. If none of the leaves fit, return `null`.
- Same enums and constraints as `/classify/describe`.
- Do not output confidence numbers.
