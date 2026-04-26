# Picker — /classify/expand

You will see:

1. A declared parent HS prefix (4 to 10 digits).
2. The user's free-text description.
3. The 12-digit leaves that descend from the declared parent.

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
