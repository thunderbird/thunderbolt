# Waitlist Module

This module implements a waitlist system that gates access to Thunderbolt. Users must join the waitlist and be approved before they can sign in.

## Endpoints

### POST `/v1/waitlist/join`

Adds an email to the waitlist.

**Request:**

```json
{ "email": "user@example.com" }
```

**Response:**

```json
{ "success": true }
```

**Behavior:**

- Normalizes email (lowercase + trim)
- If email already exists: sends a reminder email, returns success (prevents email enumeration)
- If new email: creates entry with `pending` status, sends joined waitlist email
- Handles race conditions: if concurrent requests insert the same email, the second one sends a reminder instead of failing

## Database Schema

| Column      | Type      | Description                            |
| ----------- | --------- | -------------------------------------- |
| `id`        | text      | UUID primary key                       |
| `email`     | text      | Unique, lowercase email                |
| `status`    | enum      | `pending` or `approved`                |
| `batchId`   | text      | Optional, for bulk approval operations |
| `createdAt` | timestamp | Auto-generated                         |
| `updatedAt` | timestamp | Auto-updated                           |

**Indexes:** `email`, `status`, `batch_id`

## Auth Integration

The waitlist integrates with Better Auth's email OTP flow in `backend/src/auth/auth.ts`:

1. When a user requests an OTP, the system first checks if they're an existing user
2. Existing users bypass the waitlist check (they were approved previously)
3. New users must have an `approved` status on the waitlist to receive an OTP
4. Users on waitlist but not approved receive a "not ready yet" email instead of the OTP
5. Users not on the waitlist receive no email (prevents email enumeration)

## Email Templates

Three email types are sent via Resend:

| Function                    | Template ID          | When sent                                           |
| --------------------------- | -------------------- | --------------------------------------------------- |
| `sendJoinedWaitlistEmail`   | `waitlist-joined`    | User joins the waitlist                             |
| `sendWaitlistReminderEmail` | `waitlist-reminder`  | User tries to join again but is already on the list |
| `sendWaitlistNotReadyEmail` | `waitlist-not-ready` | Pending user tries to sign in before being approved |

In development mode (no `RESEND_API_KEY`) or test mode (`NODE_ENV=test`), emails are logged to console instead of being sent.

## Security Considerations

- **No email enumeration on join**: All join requests return `{ success: true }` regardless of whether the email exists
- **No email enumeration on sign-in**: Users not on the waitlist receive no email, so attackers can't determine if an email is registered

## Testing

Run tests with:

```bash
cd backend && bun test src/waitlist/routes.test.ts
```

Tests cover:

- Basic join functionality
- Email normalization
- Duplicate handling
- Input validation (422 for invalid emails)
