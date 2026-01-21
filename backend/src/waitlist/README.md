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

- Normalizes email to lowercase
- If email already exists (active): sends a reminder email, returns success (prevents email enumeration)
- If email was soft-deleted: reactivates the entry with `pending` status
- If new email: creates entry with `pending` status, sends confirmation email
- Emails are sent asynchronously (fire-and-forget) to avoid blocking the response

### POST `/v1/waitlist/status`

Checks if an email is on the waitlist and its status.

**Request:**

```json
{ "email": "user@example.com" }
```

**Response (not on waitlist):**

```json
{ "onWaitlist": false }
```

**Response (on waitlist):**

```json
{ "onWaitlist": true, "status": "pending" | "approved" }
```

**Behavior:**

- Normalizes email to lowercase
- Only returns active entries (excludes soft-deleted)

## Database Schema

| Column      | Type      | Description                            |
| ----------- | --------- | -------------------------------------- |
| `id`        | text      | UUID primary key                       |
| `email`     | text      | Unique, lowercase email                |
| `status`    | enum      | `pending` or `approved`                |
| `batchId`   | text      | Optional, for bulk approval operations |
| `createdAt` | timestamp | Auto-generated                         |
| `updatedAt` | timestamp | Auto-updated                           |
| `deletedAt` | timestamp | Soft delete marker                     |

**Indexes:** `email`, `status`, `batch_id`

## Auth Integration

The waitlist integrates with Better Auth's email OTP flow in `backend/src/auth/auth.ts`:

1. When a user requests an OTP, the system first checks if they're an existing user
2. Existing users bypass the waitlist check (they were approved previously)
3. New users must have an `approved` status on the waitlist to receive an OTP
4. Non-approved users are silently blocked (no OTP sent) to prevent email enumeration

## Email Templates

Two email types are sent via Resend:

1. **Confirmation email** (`sendWaitlistConfirmationEmail`): Sent when a user joins the waitlist
2. **Reminder email** (`sendWaitlistReminderEmail`): Sent when a user tries to join again but is already on the list

In development mode (no `RESEND_API_KEY`), emails are logged to console instead of being sent.

## Security Considerations

- **No email enumeration**: All join requests return `{ success: true }` regardless of whether the email exists
- **Silent blocking**: Non-approved users don't receive OTPs but see the standard "check your email" message
- **Soft deletes**: Users can be removed from the waitlist without losing history (per CLAUDE.md guidelines)

## Testing

Run tests with:

```bash
cd backend && bun test src/waitlist/routes.test.ts
```

Tests cover:

- Basic join functionality
- Email normalization
- Duplicate handling
- Soft delete reactivation
- Status checking
- Input validation (422 for invalid emails)
