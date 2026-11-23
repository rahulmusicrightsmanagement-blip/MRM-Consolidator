import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('catalogue', '0014_ipi_list'),
    ]

    operations = [
        migrations.CreateModel(
            name='CleanChange',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('songs', models.JSONField(default=list)),
                ('lines', models.JSONField(default=list)),
                ('keys', models.JSONField(default=list)),
                ('items', models.JSONField(default=list)),
                ('by', models.CharField(blank=True, max_length=254)),
                ('at', models.DateTimeField(auto_now_add=True)),
                ('undone_at', models.DateTimeField(blank=True, null=True)),
                ('undone_by', models.CharField(blank=True, max_length=254)),
                ('closed', models.BooleanField(default=False)),
                ('client', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='clean_changes', to='catalogue.client')),
            ],
            options={'ordering': ['-id']},
        ),
    ]
