import os
import re
import json
import hashlib

def scan_supabase_dependencies():
    src_dir = 'src'
    results = {}

    for root, dirs, files in os.walk(src_dir):
        for f in files:
            if f.endswith(('.ts', '.tsx')):
                full_path = os.path.join(root, f).replace('\\', '/')
                with open(full_path, 'r', encoding='utf-8', errors='ignore') as fp:
                    content = fp.read()
                
                # Check supabase usages
                usages = []
                if 'from \'../lib/supabase\'' in content or 'from "@/lib/supabase"' in content or 'from \'../../lib/supabase\'' in content or 'from \'@supabase/supabase-js\'' in content:
                    usages.append("supabase_import")
                if 'supabase.auth.' in content:
                    usages.append("auth")
                if 'supabase.from(' in content:
                    usages.append("table_query")
                if 'supabase.rpc(' in content:
                    usages.append("rpc")
                if 'supabase.channel(' in content or 'supabase.removeChannel(' in content:
                    usages.append("realtime")
                if 'supabase.functions.invoke(' in content:
                    usages.append("edge_function")

                if usages:
                    results[full_path] = usages

    return results

def scan_migrations():
    mig_dir = 'supabase/migrations'
    migrations = []
    if os.path.exists(mig_dir):
        for f in sorted(os.listdir(mig_dir)):
            if f.endswith('.sql'):
                full_path = os.path.join(mig_dir, f).replace('\\', '/')
                with open(full_path, 'r', encoding='utf-8', errors='ignore') as fp:
                    sql = fp.read()
                
                has_auth_users = 'auth.users' in sql
                has_auth_uid = 'auth.uid()' in sql
                has_security_definer = 'security definer' in sql.lower()
                has_rls = 'enable row level security' in sql.lower()

                migrations.append({
                    'file': f,
                    'path': full_path,
                    'has_auth_users': has_auth_users,
                    'has_auth_uid': has_auth_uid,
                    'has_security_definer': has_security_definer,
                    'has_rls': has_rls
                })
    return migrations

def scan_edge_functions():
    ef_dir = 'supabase/functions'
    functions = []
    if os.path.exists(ef_dir):
        for f in sorted(os.listdir(ef_dir)):
            full_path = os.path.join(ef_dir, f, 'index.ts').replace('\\', '/')
            if os.path.exists(full_path):
                with open(full_path, 'r', encoding='utf-8', errors='ignore') as fp:
                    content = fp.read()
                functions.append({
                    'name': f,
                    'path': full_path,
                    'length': len(content)
                })
    return functions

def main():
    sb_deps = scan_supabase_dependencies()
    migrations = scan_migrations()
    edge_functions = scan_edge_functions()

    print(f"Scanned {len(sb_deps)} frontend files with Supabase dependencies.")
    print(f"Scanned {len(migrations)} database migration files.")
    print(f"Scanned {len(edge_functions)} Supabase Edge Functions.")

    # Save raw audit findings to JSON for traceability generation
    audit_data = {
        'frontend_dependencies': sb_deps,
        'migrations': migrations,
        'edge_functions': edge_functions
    }
    with open('docs/raw_supabase_audit.json', 'w', encoding='utf-8') as f:
        json.dump(audit_data, f, indent=2)
    print("Saved audit data to docs/raw_supabase_audit.json")

if __name__ == '__main__':
    main()
