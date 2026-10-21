# cipher-serve: Linux/macOS (cc) build. Windows: build with MinGW-w64 (see README; needs a winsock shim, not done yet).
CC ?= cc
# Portable baseline for shipping (x86-64-v2 / generic aarch64). Use `make native` for a local-only -march=native build.
UNAME_M := $(shell uname -m)
UNAME_S := $(shell uname -s)
# Output dir uses electron-builder's ${os}-${arch} names (linux-x64, mac-arm64, ...) so extraResources finds it.
OS := $(if $(filter Darwin,$(UNAME_S)),mac,linux)
ARCH := $(if $(filter x86_64,$(UNAME_M)),x64,$(if $(filter aarch64 arm64,$(UNAME_M)),arm64,$(UNAME_M)))
ifeq ($(ARCH),x64)
MARCH ?= -march=x86-64-v3
else
MARCH ?=
endif
CFLAGS ?= -O3 $(MARCH) -std=c11 -Wall -Wno-unused-function -ffp-contract=off
OUT ?= ../../resources/bin/$(OS)-$(ARCH)
$(OUT)/cipher-serve: serve.c runtime/cipher.c runtime/cipher.h
	mkdir -p $(OUT)
	$(CC) $(CFLAGS) -o $@ serve.c runtime/cipher.c -lm -lpthread
native:
	$(MAKE) MARCH=-march=native
.PHONY: native
