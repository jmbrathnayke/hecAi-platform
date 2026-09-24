"""Write the unrecoverable secrets to a file you can store somewhere safe.

    python -m scripts.backup_secrets

WHY THIS IS NOT OPTIONAL. Three values in backend/.env cannot be regenerated without destroying
data that already exists:

    NIC_PEPPER          every nic_hmac in household_members was derived with it. Lose it and the
                        duplicate-claim control (FR-10.2) cannot match any existing registration --
                        the registry becomes unreadable and every family must re-register.
    BANK_DETAILS_KEY    decrypts bank_details_ciphertext. Lose it and the Divisional Secretariat
                        can no longer read any account number already captured.
    VAPID_PRIVATE_KEY   signs push messages. Lose or rotate it and every push_subscriptions row is
                        dead: every citizen must re-grant notification permission.

SMTP_PASSWORD is included for convenience but is NOT in this class -- it can be reissued from
the SendGrid dashboard at any time.

The output file contains live secrets in plaintext. It is written outside the repository on
purpose, and the repo's .gitignore is not a defence for a path it does not cover. Move it to a
password manager or encrypted storage, then delete the copy on disk.
"""
import os
import sys
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv

sys.stdout.reconfigure(encoding="utf-8")
load_dotenv(dotenv_path=".env")

# (env name, unrecoverable?)
KEYS = [
    ("NIC_PEPPER", True),
    ("BANK_DETAILS_KEY", True),
    ("VAPID_PRIVATE_KEY", True),
    ("VAPID_PUBLIC_KEY", False),
    ("VAPID_SUBJECT", False),
    ("SMTP_PASSWORD", False),
    ("SMTP_USERNAME", False),
    ("SMTP_FROM_EMAIL", False),
]

stamp = datetime.now().strftime("%Y-%m-%d")
target = Path.home() / "Desktop" / f"HEC-SECRETS-BACKUP-{stamp}.txt"

lines = [
    "HEC AI E-Governance Platform — secret backup",
    f"Written {datetime.now().isoformat(timespec='seconds')}",
    "",
    "KEEP THIS OUT OF THE REPOSITORY, OUT OF EMAIL, AND OUT OF THE DISSERTATION.",
    "Store it in a password manager or encrypted drive, then delete this file.",
    "",
    "Values marked UNRECOVERABLE cannot be regenerated: losing one destroys access to data",
    "that already exists. See scripts/backup_secrets.py for what each one costs.",
    "",
]

missing = []
for name, unrecoverable in KEYS:
    value = os.environ.get(name)
    tag = "  [UNRECOVERABLE]" if unrecoverable else ""
    if not value:
        missing.append(name)
        lines.append(f"{name}=            # NOT SET{tag}")
    else:
        lines.append(f"{name}={value}{tag}")

target.write_text("\n".join(lines) + "\n", encoding="utf-8")

print(f"written: {target}\n")
for name, unrecoverable in KEYS:
    state = "missing" if os.environ.get(name) in (None, "") else "saved"
    mark = "UNRECOVERABLE" if unrecoverable else ""
    print(f"  {state:8s} {name:22s} {mark}")

if missing:
    print(f"\n{len(missing)} value(s) not set yet: {', '.join(missing)}")
    print("Re-run this after adding them, so the backup is complete.")

print("\nNEXT: move that file into a password manager or encrypted storage, then delete it.")
print("It is plaintext, and it is on your Desktop.")
