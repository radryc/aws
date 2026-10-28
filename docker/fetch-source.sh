#!/bin/sh
# Fetch one pinned Strata source repository without cloning its full history.
#
#   fetch-source.sh <repo-url> <commit-sha> <destination>
#
# Used by the Dockerfiles in this directory so the aws/ repository can be built
# on its own. The source repos are public and the refs are pinned below in each
# Dockerfile.
set -eu

repo_url="$1"
ref="$2"
dest="$3"

git init -q "$dest"
git -C "$dest" remote add origin "$repo_url"
git -C "$dest" fetch -q --depth 1 origin "$ref"
git -C "$dest" checkout -q --detach FETCH_HEAD
