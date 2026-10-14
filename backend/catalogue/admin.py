from django.contrib import admin

from .accounts import is_super_admin
from .models import Client, LinkDecision, Registration, Run, SourceFile, Task, Work

for model in (Client, Run, SourceFile, LinkDecision, Work, Registration, Task):
    admin.site.register(model)

# Only the super admin may open /admin/ (where users could also be edited).
admin.site.has_permission = lambda request: is_super_admin(request.user)
