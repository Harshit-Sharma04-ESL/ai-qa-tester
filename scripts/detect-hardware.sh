#!/usr/bin/env bash
# Detects CPU/GPU/RAM/VRAM and recommends the best Ollama model for this machine.
# Prints KEY="value" lines (safe to `eval`). Run directly to see the recommendation.
#
# Model family: qwen3-vl *-instruct — vision-capable, tool-calling, strong JSON output,
# and no hidden "thinking" tokens (which would make every agent turn much slower).
set -uo pipefail

cores=$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 2)
ram_kb=$(awk '/MemTotal/ {print $2}' /proc/meminfo 2>/dev/null || true)
if [ -n "${ram_kb}" ]; then ram_gb=$(( ram_kb / 1024 / 1024 )); else ram_gb=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 8589934592) / 1073741824 )); fi
cpu_model=$(awk -F: '/model name/ {gsub(/^ +/,"",$2); print $2; exit}' /proc/cpuinfo 2>/dev/null || sysctl -n machdep.cpu.brand_string 2>/dev/null || uname -m)
simd=""
grep -qw avx512f /proc/cpuinfo 2>/dev/null && simd="AVX-512" || { grep -qw avx2 /proc/cpuinfo 2>/dev/null && simd="AVX2"; }

gpu="none"; gpu_name=""; vram_gb=0; use_gpu=false
if command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi >/dev/null 2>&1; then
  gpu="nvidia"
  gpu_name=$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1)
  vram_mb=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits | sort -nr | head -1)
  vram_gb=$(( ${vram_mb%.*} / 1024 ))
  # Docker can only use the GPU with the NVIDIA Container Toolkit.
  if docker info 2>/dev/null | grep -qi 'nvidia'; then use_gpu=true; fi
elif [ -e /dev/kfd ] && command -v rocm-smi >/dev/null 2>&1; then
  gpu="amd"; gpu_name=$(rocm-smi --showproductname 2>/dev/null | awk -F: '/Card series/ {print $2; exit}')
fi

if $use_gpu; then
  if   [ "$vram_gb" -ge 22 ]; then model="qwen3-vl:30b-a3b-instruct"; why="${vram_gb} GB VRAM fits the 30B mixture-of-experts model (only ~3B active per token, so it is fast)"
  elif [ "$vram_gb" -ge 9 ];  then model="qwen3-vl:8b-instruct";      why="${vram_gb} GB VRAM fits the 8B model fully on the GPU"
  elif [ "$vram_gb" -ge 5 ];  then model="qwen3-vl:4b-instruct";      why="${vram_gb} GB VRAM fits the 4B model fully on the GPU"
  else                             model="qwen3-vl:2b-instruct";      why="small GPU (${vram_gb} GB VRAM): 2B model stays on the GPU"
  fi
  vision="$model"; why="$why; screenshots are sent to the model when explaining failures"
else
  if   [ "$ram_gb" -ge 30 ] && [ "$cores" -ge 16 ]; then model="qwen3-vl:8b-instruct"; why="CPU-only but ${cores} cores / ${ram_gb} GB RAM can run the 8B model at usable speed"
  elif [ "$ram_gb" -ge 7 ];  then model="qwen3-vl:4b-instruct"; why="CPU-only: the 4B model is the best balance (correct actions in benchmarks, ~3.3 GB RAM); 7-8B models were ~2x slower per agent turn on CPU"
  else                            model="qwen3-vl:2b-instruct"; why="CPU-only with ${ram_gb} GB RAM: the 2B model fits comfortably"
  fi
  vision=""; why="$why; failure analysis is text-only by default to keep runs fast (set VISION_MODEL to enable screenshots)"
fi

gpu_txt="no GPU"
[ "$gpu" = "nvidia" ] && gpu_txt="NVIDIA ${gpu_name} (${vram_gb} GB VRAM$($use_gpu || echo ', NVIDIA Container Toolkit missing - using CPU'))"
[ "$gpu" = "amd" ] && gpu_txt="AMD ${gpu_name} (not used: see README for ROCm)"
summary="${cpu_model} (${cores} cores${simd:+, $simd}), ${ram_gb} GB RAM, ${gpu_txt}"

printf 'HW_SUMMARY="%s"\n' "$summary"
printf 'USE_GPU="%s"\n' "$use_gpu"
printf 'OLLAMA_MODEL="%s"\n' "$model"
printf 'VISION_MODEL="%s"\n' "$vision"
printf 'MODEL_REASON="%s"\n' "$why"
