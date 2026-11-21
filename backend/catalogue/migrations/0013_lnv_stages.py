from django.db import migrations, models
from django.utils import timezone


def mark_started_clients(apps, schema_editor):
    """Clients already checked against IPRS are past Muso vs LNV: they stay in LNV vs IPRS (with their uploaded LNV)."""
    Client = apps.get_model("catalogue", "Client")
    SourceFile = apps.get_model("catalogue", "SourceFile")
    ids = set(SourceFile.objects.filter(kind="iprs", run__society="IPRS", run__client__isnull=False).values_list("run__client_id", flat=True))
    Client.objects.filter(id__in=ids, stage1_done_at__isnull=True).update(stage1_done_at=timezone.now())


class Migration(migrations.Migration):

    dependencies = [
        ('catalogue', '0012_name_alias'),
    ]

    operations = [
        migrations.AddField(model_name='client', name='stage1_done_at', field=models.DateTimeField(blank=True, null=True)),
        migrations.AddField(model_name='client', name='stage1_done_by', field=models.CharField(blank=True, max_length=254)),
        migrations.AddField(model_name='masterfile', name='stage', field=models.PositiveSmallIntegerField(default=1)),
        migrations.AddField(model_name='masterfile', name='origin', field=models.CharField(default='upload', max_length=20)),
        migrations.AddField(model_name='masterfile', name='uploaded_by', field=models.CharField(blank=True, max_length=254)),
        migrations.RunPython(mark_started_clients, migrations.RunPython.noop),
    ]
