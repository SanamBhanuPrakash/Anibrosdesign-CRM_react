import os
import json
import hashlib
import sys

def main():
    transcript_path = r'C:\Users\Sanam\.gemini\antigravity-ide\brain\a8244f0e-4128-4a53-bfbb-f759674d7538\.system_generated\logs\transcript_full.jsonl'
    directive_file = r'docs/MASTER_ENGINEERING_DIRECTIVE.md'
    manifest_file = r'docs/master_directive_chunks_manifest.json'

    # Step 1: Extract verbatim from transcript
    last_user_input = None
    with open(transcript_path, 'r', encoding='utf-8') as f:
        for line in f:
            try:
                data = json.loads(line)
                if data.get('type') == 'USER_INPUT':
                    last_user_input = data
            except Exception:
                pass

    if not last_user_input:
        print("ERROR: Could not find USER_INPUT in transcript", file=sys.stderr)
        sys.exit(1)

    raw_content = last_user_input['content']
    start_tag = '<USER_REQUEST>'
    end_tag = '</USER_REQUEST>'

    s_idx = raw_content.find(start_tag)
    e_idx = raw_content.find(end_tag)

    if s_idx == -1 or e_idx == -1:
        print("ERROR: Could not find <USER_REQUEST> tags", file=sys.stderr)
        sys.exit(1)

    verbatim_text = raw_content[s_idx + len(start_tag):e_idx].strip()

    # Step 2: Write verbatim to docs/MASTER_ENGINEERING_DIRECTIVE.md
    os.makedirs('docs', exist_ok=True)
    with open(directive_file, 'w', encoding='utf-8', newline='') as f:
        f.write(verbatim_text)

    # Step 3: Compute verification metrics
    with open(directive_file, 'rb') as f:
        file_bytes = f.read()

    sha256_digest = hashlib.sha256(file_bytes).hexdigest()
    byte_count = len(file_bytes)
    char_count = len(verbatim_text)
    lines = verbatim_text.splitlines()
    line_count = len(lines)

    print("==================================================")
    print("VERBATIM MASTER DIRECTIVE CAPTURE METRICS:")
    print(f"Target File:      {directive_file}")
    print(f"SHA-256 Digest:   {sha256_digest}")
    print(f"Byte Count:       {byte_count}")
    print(f"Character Count:  {char_count}")
    print(f"Line Count:       {line_count}")
    print("==================================================")

    # Step 4: Systematic Section & Heading Chunking
    # Split along major headings (# and ##)
    # Target chunk size: 8,000 - 12,000 characters. If a section exceeds 12,000, split at subheadings or paragraphs.
    
    chunks = []
    current_chunk_start = 0
    
    # We will identify heading boundaries
    heading_positions = []
    pos = 0
    for line in verbatim_text.splitlines(keepends=True):
        if line.startswith('# ') or line.startswith('## '):
            heading_positions.append((pos, line.strip()))
        pos += len(line)

    # Build logical sections based on headings
    sections = []
    for i, (h_pos, h_title) in enumerate(heading_positions):
        next_pos = heading_positions[i+1][0] if i + 1 < len(heading_positions) else len(verbatim_text)
        sections.append({
            'start': h_pos,
            'end': next_pos,
            'heading': h_title,
            'text': verbatim_text[h_pos:next_pos]
        })

    # Group or split sections into chunks between ~5,000 and 12,000 chars
    chunk_list = []
    current_chunk_sections = []
    current_chunk_len = 0
    current_chunk_start = 0

    for sec in sections:
        sec_len = len(sec['text'])
        # If single section is > 12,000, we might need to split it by paragraphs
        if sec_len > 12000:
            # First flush current accumulated chunk if any
            if current_chunk_sections:
                c_text = verbatim_text[current_chunk_start:sec['start']]
                chunk_list.append({
                    'start': current_chunk_start,
                    'end': sec['start'],
                    'text': c_text,
                    'headings': [s['heading'] for s in current_chunk_sections]
                })
                current_chunk_sections = []
                current_chunk_len = 0

            # Split large section by paragraphs
            sec_pos = sec['start']
            paragraphs = sec['text'].split('\n\n')
            p_chunk_start = sec_pos
            p_accum = []
            p_len = 0
            for p in paragraphs:
                p_text_with_sep = p + '\n\n'
                if p_len + len(p_text_with_sep) > 10000 and p_accum:
                    p_chunk_end = p_chunk_start + p_len
                    chunk_list.append({
                        'start': p_chunk_start,
                        'end': p_chunk_end,
                        'text': verbatim_text[p_chunk_start:p_chunk_end],
                        'headings': [sec['heading'] + " (part)"]
                    })
                    p_chunk_start = p_chunk_end
                    p_accum = [p]
                    p_len = len(p_text_with_sep)
                else:
                    p_accum.append(p)
                    p_len += len(p_text_with_sep)

            if p_accum:
                chunk_list.append({
                    'start': p_chunk_start,
                    'end': sec['end'],
                    'text': verbatim_text[p_chunk_start:sec['end']],
                    'headings': [sec['heading'] + " (final part)"]
                })
            current_chunk_start = sec['end']
        elif current_chunk_len + sec_len > 12000 and current_chunk_sections:
            # Flush current chunk
            c_text = verbatim_text[current_chunk_start:sec['start']]
            chunk_list.append({
                'start': current_chunk_start,
                'end': sec['start'],
                'text': c_text,
                'headings': [s['heading'] for s in current_chunk_sections]
            })
            current_chunk_start = sec['start']
            current_chunk_sections = [sec]
            current_chunk_len = sec_len
        else:
            if not current_chunk_sections:
                current_chunk_start = sec['start']
            current_chunk_sections.append(sec)
            current_chunk_len += sec_len

    if current_chunk_sections:
        c_text = verbatim_text[current_chunk_start:len(verbatim_text)]
        chunk_list.append({
            'start': current_chunk_start,
            'end': len(verbatim_text),
            'text': c_text,
            'headings': [s['heading'] for s in current_chunk_sections]
        })

    # Step 5: Validate and build manifest
    manifest_chunks = []
    reconstructed_text = ""

    for idx, c in enumerate(chunk_list):
        c_bytes = c['text'].encode('utf-8')
        c_sha256 = hashlib.sha256(c_bytes).hexdigest()
        
        # Calculate line range
        start_line = verbatim_text[:c['start']].count('\n') + 1
        end_line = verbatim_text[:c['end']].count('\n') + 1

        reconstructed_text += c['text']

        chunk_entry = {
            'sequence_number': idx + 1,
            'start_offset': c['start'],
            'end_offset': c['end'],
            'start_line': start_line,
            'end_line': end_line,
            'char_count': len(c['text']),
            'byte_count': len(c_bytes),
            'sha256': c_sha256,
            'headings': c['headings']
        }
        manifest_chunks.append(chunk_entry)

    # Step 6: Strict validation
    if reconstructed_text != verbatim_text:
        print("FATAL ERROR: Reconstructed text does not match original verbatim text!", file=sys.stderr)
        print(f"Original len: {len(verbatim_text)}, Reconstructed len: {len(reconstructed_text)}", file=sys.stderr)
        sys.exit(1)

    manifest = {
        'source_file': directive_file,
        'source_sha256': sha256_digest,
        'source_char_count': char_count,
        'source_byte_count': byte_count,
        'source_line_count': line_count,
        'total_chunks': len(manifest_chunks),
        'chunks': manifest_chunks
    }

    with open(manifest_file, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=2)

    print(f"Manifest written to: {manifest_file}")
    print(f"Total chunks created: {len(manifest_chunks)}")
    print("Verification: Reconstructed text EXACT MATCH 100% of source.")
    for chunk in manifest_chunks:
        print(f"  Chunk {chunk['sequence_number']}: lines {chunk['start_line']}-{chunk['end_line']}, "
              f"chars {chunk['char_count']}, bytes {chunk['byte_count']} | Headings: {', '.join(chunk['headings'])}")

if __name__ == '__main__':
    main()
