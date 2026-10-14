"""Create the super admin account (settings.SUPER_ADMIN_EMAIL) or reset its password.

    python manage.py superadmin            # create it if missing (asks for a password)
    python manage.py superadmin --reset    # set a new password
    MRM_SUPER_ADMIN_PASSWORD=... python manage.py superadmin --no-input
"""
import getpass
import os

from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.core.management.base import BaseCommand, CommandError


class Command(BaseCommand):
    help = "Create the super admin account or reset its password."

    def add_arguments(self, parser):
        parser.add_argument("--reset", action="store_true", help="Set a new password even if the account exists.")
        parser.add_argument("--no-input", action="store_true", help="Never prompt; use MRM_SUPER_ADMIN_PASSWORD.")

    def handle(self, *args, reset=False, no_input=False, **options):
        User = get_user_model()
        email = settings.SUPER_ADMIN_EMAIL
        user = User.objects.filter(username__iexact=email).first() or User.objects.filter(email__iexact=email).first()
        if user and not reset:
            self._ensure_flags(user, email)
            self.stdout.write(f"Super admin {email} already exists.")
            return

        password = os.environ.get("MRM_SUPER_ADMIN_PASSWORD", "")
        if not password:
            if no_input:
                self.stderr.write(self.style.WARNING(
                    f"Super admin {email} has no account yet. Set MRM_SUPER_ADMIN_PASSWORD or run "
                    "`python manage.py superadmin` to create it."))
                return
            password = self._ask(email)

        user = user or User(username=email, email=email, first_name="Super admin")
        try:
            validate_password(password, user)
        except ValidationError as e:
            raise CommandError(" ".join(e.messages))
        user.set_password(password)
        self._ensure_flags(user, email)
        self.stdout.write(self.style.SUCCESS(f"Super admin {email} is ready – sign in with this password."))

    def _ask(self, email):
        self.stdout.write(f"Set the password for the super admin ({email}).")
        while True:
            first = getpass.getpass("Password: ")
            if first and first == getpass.getpass("Password again: "):
                return first
            self.stderr.write("Passwords did not match or were empty – try again.")

    @staticmethod
    def _ensure_flags(user, email):
        user.username = email
        user.email = email
        user.is_active = user.is_staff = user.is_superuser = True
        user.save()
