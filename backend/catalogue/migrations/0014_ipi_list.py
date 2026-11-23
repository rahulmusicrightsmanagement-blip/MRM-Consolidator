import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('catalogue', '0013_lnv_stages'),
    ]

    operations = [
        migrations.CreateModel(
            name='IpiUpload',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('original_name', models.CharField(blank=True, max_length=255)),
                ('kind', models.CharField(default='upload', max_length=10)),
                ('stats', models.JSONField(blank=True, default=dict)),
                ('uploaded_by', models.CharField(blank=True, max_length=254)),
                ('uploaded_at', models.DateTimeField(auto_now_add=True)),
            ],
        ),
        migrations.CreateModel(
            name='IpiName',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('key', models.CharField(max_length=120, unique=True)),
                ('member', models.CharField(db_index=True, max_length=40)),
                ('member_name', models.CharField(max_length=300)),
                ('name', models.CharField(max_length=300)),
                ('type', models.CharField(max_length=4)),
                ('ipi', models.CharField(blank=True, db_index=True, max_length=11)),
                ('role', models.CharField(blank=True, max_length=4)),
                ('internal_no', models.CharField(blank=True, max_length=40)),
                ('sr', models.CharField(blank=True, max_length=20)),
                ('updated_at', models.DateTimeField(auto_now=True)),
                ('added_in', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to='catalogue.ipiupload')),
                ('changed_in', models.ForeignKey(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+', to='catalogue.ipiupload')),
            ],
            options={'ordering': ['member_name', 'member', 'type', 'name']},
        ),
    ]
