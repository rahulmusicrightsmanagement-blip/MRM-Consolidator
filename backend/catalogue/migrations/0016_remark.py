from django.db import migrations, models

# The team's first list, and the five kinds of adaptation with their rule
FIRST = [
    ("Adaptation", ""),
    ("Uncredited Adaptation", ""),
    ("Lyrical Adaptation", ""),
    ("Language Adaptation", ""),
    ("Credited Adaptation", ""),
    ("Same melody, translated lyrics", "Lyrical Translation/Adaptation: the original lyrics in another language, the same melody. Linked to the original musical composition."),
    ("Same melody, completely new lyrics", "Lyrical Adaptation/Substituted Lyrics: the original melody with new lyrics in another language. The new lyrics are linked to the original composition."),
    ("Same melody and lyrics, different singer", "Cover Version/New Recording: melody and lyrics unchanged, recorded or performed by a different singer."),
    ("Same melody, different instrumentation", "Arrangement/New Recording: the original melody with other instruments, arrangement or production, depending on the extent of the changes."),
    ("Melody substantially modified", "Musical Adaptation: the original melody is significantly changed or reworked. May require authorization from the original rights holders."),
]


def add(apps, schema_editor):
    Remark = apps.get_model("catalogue", "Remark")
    if not Remark.objects.exists():
        Remark.objects.bulk_create([Remark(name=n, help=h, position=i) for i, (n, h) in enumerate(FIRST, start=1)])


class Migration(migrations.Migration):

    dependencies = [
        ('catalogue', '0015_clean_change'),
    ]

    operations = [
        migrations.CreateModel(
            name='Remark',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('name', models.CharField(max_length=120)),
                ('help', models.CharField(blank=True, max_length=400)),
                ('position', models.PositiveIntegerField(default=0)),
                ('active', models.BooleanField(default=True)),
                ('updated_by', models.CharField(blank=True, max_length=254)),
                ('updated_at', models.DateTimeField(auto_now=True)),
            ],
            options={'ordering': ['position', 'id']},
        ),
        migrations.RunPython(add, migrations.RunPython.noop),
    ]
