# Tauri Signing Keys

## Generate

```sh
mkdir -p ~/.tauri

# Generate a secure password and save it (a password manager is recommended)
PASSWORD=$(openssl rand -base64 32)
echo "Your signing key password: $PASSWORD"

tauri signer generate -p "$PASSWORD" -w ~/.tauri/thunderbolt.key
```

| File                           | Role                         |
| ------------------------------ | ---------------------------- |
| `~/.tauri/thunderbolt.key`     | Private key. Keep it secret. |
| `~/.tauri/thunderbolt.key.pub` | Public key.                  |

Never share or commit the private key. If you lose the key or the password, you cannot sign updates.

## Use

Set these environment variables when signing:

```sh
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/thunderbolt.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="your-password-here"
```
