"""Login, logout and user management.

Everyone signs in with email + password. Only the super admin (settings.SUPER_ADMIN_EMAIL) can add,
disable, reset or remove users; every other API call just needs a signed-in user.
"""
import json

from django.conf import settings
from django.contrib.auth import authenticate, get_user_model, login, logout, update_session_auth_hash
from django.contrib.auth.password_validation import validate_password
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.core.validators import validate_email
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.decorators.http import require_http_methods

User = get_user_model()

# API paths that work without signing in.
PUBLIC_API = {"/api/auth/login/", "/api/auth/me/", "/api/auth/logout/"}
# Wrong passwords allowed per email + address before a short lock-out.
MAX_FAILURES = 8
LOCKOUT_SECONDS = 15 * 60


def is_super_admin(user):
    return bool(user and user.is_authenticated and user.is_active
                and user.email.strip().lower() == settings.SUPER_ADMIN_EMAIL)


class LoginRequiredMiddleware:
    """Every /api/ call needs a signed-in user; the React app shows the login page on 401."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith("/api/") and request.path not in PUBLIC_API and not request.user.is_authenticated:
            return JsonResponse({"error": "Please sign in.", "auth": "required"}, status=401)
        return self.get_response(request)


def _body(request):
    try:
        return json.loads(request.body or b"{}")
    except json.JSONDecodeError:
        return {}


def _user_json(user):
    return {"id": user.id, "email": user.email, "name": user.first_name, "is_active": user.is_active,
            "is_super_admin": is_super_admin(user),
            "last_login": user.last_login.isoformat() if user.last_login else None,
            "date_joined": user.date_joined.isoformat()}


def _password_error(password, user=None):
    try:
        validate_password(password, user)
    except ValidationError as e:
        return " ".join(e.messages)
    return None


def _forbidden():
    return JsonResponse({"error": "Only the super admin can manage users."}, status=403)


# ---------------------------------------------------------------- sign in / out

@ensure_csrf_cookie
@require_http_methods(["GET"])
def me(request):
    """Who is signed in (or null). Also sets the CSRF cookie the React app sends back."""
    return JsonResponse({"user": _user_json(request.user) if request.user.is_authenticated else None})


@require_http_methods(["POST"])
def login_view(request):
    data = _body(request)
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    if not email or not password:
        return JsonResponse({"error": "Enter your email and password."}, status=400)
    key = f"login-fail:{email}:{request.META.get('REMOTE_ADDR', '')}"
    if cache.get(key, 0) >= MAX_FAILURES:
        return JsonResponse({"error": "Too many wrong attempts. Try again in 15 minutes."}, status=429)
    user = authenticate(request, username=email, password=password)
    if user is None:
        cache.set(key, cache.get(key, 0) + 1, LOCKOUT_SECONDS)
        return JsonResponse({"error": "Wrong email or password."}, status=400)
    cache.delete(key)
    login(request, user)
    return JsonResponse({"user": _user_json(user)})


@require_http_methods(["POST"])
def logout_view(request):
    logout(request)
    return JsonResponse({"user": None})


@require_http_methods(["POST"])
def change_password(request):
    data = _body(request)
    user = request.user
    if not user.check_password(data.get("current") or ""):
        return JsonResponse({"error": "Your current password is wrong."}, status=400)
    new = data.get("new") or ""
    if error := _password_error(new, user):
        return JsonResponse({"error": error}, status=400)
    user.set_password(new)
    user.save(update_fields=["password"])
    update_session_auth_hash(request, user)  # stay signed in on this device
    return JsonResponse({"user": _user_json(user)})


# ---------------------------------------------------------------- users (super admin only)

@require_http_methods(["GET", "POST"])
def users(request):
    if not is_super_admin(request.user):
        return _forbidden()
    if request.method == "GET":
        return JsonResponse({"users": [_user_json(u) for u in User.objects.order_by("email")]})
    data = _body(request)
    email = (data.get("email") or "").strip().lower()
    name = (data.get("name") or "").strip()[:150]
    password = data.get("password") or ""
    try:
        validate_email(email)
    except ValidationError:
        return JsonResponse({"error": "Enter a valid email address."}, status=400)
    if User.objects.filter(username__iexact=email).exists() or User.objects.filter(email__iexact=email).exists():
        return JsonResponse({"error": "A user with this email already exists."}, status=400)
    candidate = User(username=email, email=email, first_name=name)
    if error := _password_error(password, candidate):
        return JsonResponse({"error": error}, status=400)
    candidate.set_password(password)
    candidate.save()
    return JsonResponse(_user_json(candidate), status=201)


@require_http_methods(["PATCH", "DELETE"])
def user_detail(request, user_id):
    if not is_super_admin(request.user):
        return _forbidden()
    user = get_object_or_404(User, id=user_id)
    if is_super_admin(user):
        return JsonResponse({"error": "The super admin account cannot be changed here."}, status=400)
    if request.method == "DELETE":
        user.delete()
        return JsonResponse({"deleted": user_id})
    data = _body(request)
    if "name" in data:
        user.first_name = (data["name"] or "").strip()[:150]
    if "is_active" in data:
        user.is_active = bool(data["is_active"])
    if data.get("password"):
        if error := _password_error(data["password"], user):
            return JsonResponse({"error": error}, status=400)
        user.set_password(data["password"])
    # No session cleanup needed: Django rejects a disabled user, or a session made before a password change,
    # on their very next request.
    user.save()
    return JsonResponse(_user_json(user))
