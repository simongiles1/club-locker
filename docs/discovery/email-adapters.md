# Email Provider Adapters (Outbound)

## Requirement
Modular **Email Adapter** per constitution; IT may approve Mailchimp, SendGrid, Microsoft Graph, or SMTP.

## Interface
Outbound sends are **staged** first: `draft` → director `approve` → `sent` (or `failed`).

## Implementations
| Adapter | Use case | Notes |
|---------|----------|--------|
| `ConsoleEmailAdapter` | Dev / tests | Logs payload only |
| `MailchimpAdapter` | Production candidate | Template merge vars; batch campaigns need API review |
| `SmtpAdapter` | Fallback | Facility SMTP if allowed |

## Configuration
Environment variables (never committed):
- `EMAIL_ADAPTER=console|mailchimp|smtp`
- Provider-specific keys documented in `apps/api/.env.example`
