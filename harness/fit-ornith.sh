#!/usr/bin/env bash
# Largest context this model holds entirely on eleven2go's 3090.
#
# Residency is read from the server log's `load_tensors: offloaded N/M layers`
# and never from /api/ps, which does not count the KV cache -- it once reported
# 16.3 GiB while nvidia-smi showed 21.3, a 4.6 GiB gap that was KV plus compute
# buffers. nvidia-smi is printed alongside as the real number.
set -uo pipefail
E="http://192.168.178.161:11434"
MODEL="${MODEL:-ornith15-a3b_tb:35b-iq4xs-128k}"

offload_line() {
	ssh -o BatchMode=yes eleven2go 'powershell -NoProfile -Command "(Get-Content ($env:LOCALAPPDATA + \"\Ollama\server.log\") | Select-String -Pattern \"offloaded \d+/\d+ layers\" | Select-Object -Last 1).Line"' 2>/dev/null | tr -d '\r'
}
vram() {
	ssh -o BatchMode=yes eleven2go 'nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader' 2>/dev/null | tr -d '\r'
}
unload() {
	curl -s --max-time 60 "$E/api/generate" -d "{\"model\":\"$MODEL\",\"keep_alive\":0}" >/dev/null 2>&1
	sleep 8
}

for ctx in 131072 110592 102400; do
	echo "=== trying num_ctx=$ctx"
	unload
	before="$(offload_line)"
	out=$(curl -s --max-time 900 "$E/api/generate" -d "{\"model\":\"$MODEL\",\"prompt\":\"say OK\",\"stream\":false,\"think\":false,\"options\":{\"num_ctx\":$ctx,\"num_gpu\":99},\"num_predict\":8}" 2>&1)
	if grep -q '"error"' <<< "$out"; then
		echo "  load failed: $(head -c 300 <<< "$out")"
		continue
	fi
	sleep 3
	line="$(offload_line)"
	echo "  $line"
	echo "  vram: $(vram)"
	read -r a b < <(sed -n 's/.*offloaded \([0-9]\+\)\/\([0-9]\+\) layers.*/\1 \2/p' <<< "$line")
	if [[ -n "${a:-}" && "$a" == "${b:-x}" ]]; then
		echo "FITS num_ctx=$ctx layers=$a/$b"
		echo "$ctx" > /srv/dev-disk-by-uuid-92295e2c-12bd-4d15-a50c-1d80e1a33ee8/spool/manic-harness/ornith-ctx.txt
		exit 0
	fi
	echo "  not fully resident at $ctx"
done
echo "NONE FIT"
exit 1
