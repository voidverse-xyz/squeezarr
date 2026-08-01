#!/usr/bin/env bash

set -euo pipefail

readonly PUSH_IMAGE="voidversexyz/squeezarr:latest"
readonly PODMAN_IMAGE="docker.io/${PUSH_IMAGE}"

if [[ $# -ne 0 ]]; then
    echo "Usage: $0" >&2
    exit 64
fi

for command_name in podman docker; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "Required command not found: $command_name" >&2
        exit 127
    fi
done

echo "Building $PUSH_IMAGE with Podman..."
podman build --format docker --file Containerfile --tag "$PODMAN_IMAGE" .

echo "Loading $PUSH_IMAGE into Docker..."
load_output="$(podman save --format docker-archive "$PODMAN_IMAGE" | docker load)"
printf "%s\n" "$load_output"

loaded_image=""
while IFS= read -r line; do
    case "$line" in
        "Loaded image: "*) loaded_image="${line#Loaded image: }" ;;
        "Loaded image ID: "*) loaded_image="${line#Loaded image ID: }" ;;
    esac
done <<<"$load_output"

if [[ -z "$loaded_image" ]]; then
    echo "Docker did not report the loaded image reference" >&2
    exit 1
fi

echo "Tagging $PUSH_IMAGE in Docker..."
docker tag "$loaded_image" "$PUSH_IMAGE"

echo "Pushing $PUSH_IMAGE with Docker..."
docker push "$PUSH_IMAGE"

echo "Published $PUSH_IMAGE"
