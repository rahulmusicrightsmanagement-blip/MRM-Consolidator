from django.db import migrations
from django.db.models import F


def merge(apps, schema_editor):
    """IPRS "Map with master" and "Fill IPRS columns" became one step: step 3 and 4 move down by one."""
    Run = apps.get_model("catalogue", "Run")
    Run.objects.filter(society="IPRS", confirmed_step__gte=3).update(confirmed_step=F("confirmed_step") - 1)


def split(apps, schema_editor):
    Run = apps.get_model("catalogue", "Run")
    Run.objects.filter(society="IPRS", confirmed_step__gte=3).update(confirmed_step=F("confirmed_step") + 1)


class Migration(migrations.Migration):
    dependencies = [("catalogue", "0009_link_also_rows")]
    operations = [migrations.RunPython(merge, split)]
