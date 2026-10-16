import os
import re
import json

def main():
    mig_dir = 'supabase/migrations'
    tables = set()
    enums = set()
    functions = set()
    triggers = set()
    policies = set()
    foreign_keys = []

    for f in sorted(os.listdir(mig_dir)):
        if not f.endswith('.sql') or 'DEPLOY' in f:
            continue
        with open(os.path.join(mig_dir, f), 'r', encoding='utf-8', errors='ignore') as fp:
            sql = fp.read()
        
        for t in re.findall(r'CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z0-9_\.]+)', sql, re.IGNORECASE):
            clean_t = t.replace('public.', '').strip()
            if not clean_t.startswith('pg_'):
                tables.add(clean_t)
        for e in re.findall(r'CREATE\s+TYPE\s+([a-zA-Z0-9_\.]+)\s+AS\s+ENUM', sql, re.IGNORECASE):
            enums.add(e.replace('public.', '').strip())
        for fn in re.findall(r'CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-zA-Z0-9_\.]+)', sql, re.IGNORECASE):
            functions.add(fn.replace('public.', '').strip())
        for trg in re.findall(r'CREATE\s+TRIGGER\s+([a-zA-Z0-9_]+)', sql, re.IGNORECASE):
            triggers.add(trg.strip())
        for pol in re.findall(r'CREATE\s+POLICY\s+[\"\']?([a-zA-Z0-9_\s]+)[\"\']?\s+ON\s+([a-zA-Z0-9_\.]+)', sql, re.IGNORECASE):
            policies.add(f"{pol[0].strip()} ON {pol[1].replace('public.', '').strip()}")

    result = {
        'tables': sorted(list(tables)),
        'enums': sorted(list(enums)),
        'functions': sorted(list(functions)),
        'triggers': sorted(list(triggers)),
        'policies_count': len(policies),
        'policies': sorted(list(policies))
    }

    print(f"Total tables: {len(result['tables'])}")
    for t in result['tables']:
        print(f"  Table: {t}")
    print(f"Total enums: {len(result['enums'])}")
    for e in result['enums']:
        print(f"  Enum: {e}")
    print(f"Total functions: {len(result['functions'])}")
    print(f"Total triggers: {len(result['triggers'])}")
    print(f"Total policies: {len(result['policies'])}")

    with open('docs/legacy_schema_catalog.json', 'w', encoding='utf-8') as f:
        json.dump(result, f, indent=2)

if __name__ == '__main__':
    main()
