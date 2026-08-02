{{- define "helix.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "helix.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "helix.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" -}}
{{- end -}}

{{- define "helix.labels" -}}
helm.sh/chart: {{ include "helix.chart" . }}
app.kubernetes.io/name: {{ include "helix.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: helix
helix.io/security-tier: {{ .Values.security.tier | quote }}
{{- end -}}

{{- define "helix.selectorLabels" -}}
app.kubernetes.io/name: {{ include "helix.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "helix.selectedImageRepository" -}}
{{- ternary .Values.fips.imageRepository .Values.image.repository .Values.fips.enabled -}}
{{- end -}}

{{- define "helix.selectedImageDigest" -}}
{{- ternary .Values.fips.imageDigest .Values.image.digest .Values.fips.enabled -}}
{{- end -}}

{{- define "helix.image" -}}
{{- $repository := include "helix.selectedImageRepository" . -}}
{{- $digest := include "helix.selectedImageDigest" . -}}
{{- if $digest -}}
{{- printf "%s@%s" $repository $digest -}}
{{- else -}}
{{- printf "%s:%s" $repository .Values.image.tag -}}
{{- end -}}
{{- end -}}

{{- define "helix.validateValues" -}}
{{- $digest := include "helix.selectedImageDigest" . -}}
{{- if and .Values.stig.imagePolicy.requireDigest (not $digest) -}}
{{- fail "stig.imagePolicy.requireDigest requires image.digest or fips.imageDigest for the selected image" -}}
{{- end -}}
{{- if and .Values.stig.imagePolicy.forbidLatestTag (not $digest) (eq .Values.image.tag "latest") -}}
{{- fail "stig.imagePolicy.forbidLatestTag forbids image.tag=latest when no digest is set" -}}
{{- end -}}
{{- /* MVP packaging fail-closed: refuse accidental Full Workspace defaults without profile=full. */ -}}
{{- $profile := "mvp" -}}
{{- if and .Values.workspace .Values.workspace.profile -}}
{{- $profile = .Values.workspace.profile -}}
{{- end -}}
{{- if ne $profile "full" -}}
{{- $apps := "mail,drive,chat,assistant" -}}
{{- if and .Values.workspace .Values.workspace.apps -}}
{{- $apps = .Values.workspace.apps -}}
{{- end -}}
{{- if ne $apps "mail,drive,chat,assistant" -}}
{{- fail "workspace.apps must be mail,drive,chat,assistant unless workspace.profile=full (PKG flip; see docs/architecture/ha-rpo-rto.md)" -}}
{{- end -}}
{{- if and .Values.workspace .Values.workspace.editorsMigrationsEnabled -}}
{{- fail "workspace.editorsMigrationsEnabled must be false unless workspace.profile=full" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "helix.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "helix.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "helix.configJson" -}}
{{- $security := dict "tier" .Values.security.tier -}}
{{- if .Values.security.overrides -}}
{{- $_ := set $security "overrides" .Values.security.overrides -}}
{{- end -}}
{{- $platform := deepCopy .Values.helixConfig.platform -}}
{{- $_ := set $platform "endpoints" (dict "postgres" (dict "external" true "cloudNativePg" .Values.cloudnativepg.enabled) "cloudNativePg" (dict "enabled" .Values.cloudnativepg.enabled "endpoint" (printf "%s-rw" .Values.cloudnativepg.clusterName)) "s3" (dict "endpoint" .Values.external.s3.endpoint "bucket" .Values.external.s3.bucket "region" .Values.external.s3.region) "kms" (dict "enabled" .Values.external.kms.enabled "endpoint" .Values.external.kms.endpoint "keyId" .Values.external.kms.keyId) "vault" (dict "enabled" .Values.external.vault.enabled "address" .Values.external.vault.address "namespace" .Values.external.vault.namespace) "siem" (dict "enabled" .Values.external.siem.enabled "endpoint" .Values.external.siem.endpoint "format" .Values.external.siem.format)) -}}
{{- $_ := set $platform "runtime" (dict "fips" (dict "enabled" .Values.fips.enabled "crypto" .Values.fips.crypto) "stig" (dict "enabled" .Values.stig.enabled "profile" .Values.stig.profile "imagePolicy" .Values.stig.imagePolicy) "airgap" .Values.airgap) -}}
{{- $modules := dict -}}
{{- if .Values.workspace -}}
{{- if .Values.workspace.modules -}}
{{- $modules = .Values.workspace.modules -}}
{{- end -}}
{{- end -}}
{{- dict "security" $security "modules" $modules "plugins" .Values.helixConfig.plugins "platform" $platform | toJson -}}
{{- end -}}

{{/*
helix.containerEnv renders the shared container env list for the Helix app.
Both the primary Deployment and the optional role-based Deployments include
this so a role replica boots from the same configmap + external secrets as the
default role. Input is the chart root context.
*/}}
{{- define "helix.containerEnv" -}}
- name: NODE_ENV
  value: production
- name: HOST
  value: 0.0.0.0
- name: PORT
  value: "3000"
- name: HELIX_CONFIG_JSON
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: HELIX_CONFIG_JSON
- name: HELIX_SECURITY_TIER
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: HELIX_SECURITY_TIER
- name: HELIX_PUBLIC_URL
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: HELIX_PUBLIC_URL
- name: HELIX_WORKSPACE_PROFILE
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: HELIX_WORKSPACE_PROFILE
- name: HELIX_APPS
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: HELIX_APPS
- name: HELIX_EDITORS_MIGRATIONS_ENABLED
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: HELIX_EDITORS_MIGRATIONS_ENABLED
{{- /*
  FIPS env is opt-in: emitted only when fips.enabled is true. When omitted the
  crypto adapter sees no HELIX_FIPS_* / HELIX_CRYPTO_* env and self-initializes
  the default, byte-identical NodeCryptoProvider. The matching ConfigMap keys
  are gated identically, so a default install has no FIPS surface at all.
*/}}
{{- if .Values.fips.enabled }}
- name: HELIX_FIPS_MODE
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: HELIX_FIPS_MODE
- name: HELIX_CRYPTO_ADAPTER
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: HELIX_CRYPTO_ADAPTER
- name: HELIX_TLS_MIN_VERSION
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: HELIX_TLS_MIN_VERSION
- name: HELIX_TLS_ALLOWED_CIPHERS
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: HELIX_TLS_ALLOWED_CIPHERS
{{- end }}
- name: LOG_LEVEL
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: LOG_LEVEL
- name: DATABASE_URL
  {{- if .Values.external.postgres.url }}
  value: {{ .Values.external.postgres.url | quote }}
  {{- else }}
  valueFrom:
    secretKeyRef:
      name: {{ required "external.postgres.urlSecret.name is required when external.postgres.url is empty" .Values.external.postgres.urlSecret.name | quote }}
      key: {{ .Values.external.postgres.urlSecret.key | quote }}
  {{- end }}
- name: REDIS_URL
  {{- if .Values.external.redis.url }}
  value: {{ .Values.external.redis.url | quote }}
  {{- else }}
  valueFrom:
    secretKeyRef:
      name: {{ required "external.redis.urlSecret.name is required when external.redis.url is empty" .Values.external.redis.urlSecret.name | quote }}
      key: {{ .Values.external.redis.urlSecret.key | quote }}
  {{- end }}
- name: NATS_URL
  {{- if .Values.external.nats.url }}
  value: {{ .Values.external.nats.url | quote }}
  {{- else }}
  valueFrom:
    secretKeyRef:
      name: {{ required "external.nats.urlSecret.name is required when external.nats.url is empty" .Values.external.nats.urlSecret.name | quote }}
      key: {{ .Values.external.nats.urlSecret.key | quote }}
  {{- end }}
- name: MEILI_HOST
  value: {{ .Values.external.meilisearch.host | quote }}
- name: MEILI_MASTER_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.external.meilisearch.masterKeySecret.name | quote }}
      key: {{ .Values.external.meilisearch.masterKeySecret.key | quote }}
- name: RUSTFS_ENDPOINT
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: RUSTFS_ENDPOINT
- name: RUSTFS_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.external.s3.accessKeySecret.name | quote }}
      key: {{ .Values.external.s3.accessKeySecret.key | quote }}
- name: RUSTFS_SECRET_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.external.s3.secretKeySecret.name | quote }}
      key: {{ .Values.external.s3.secretKeySecret.key | quote }}
- name: KMS_ENDPOINT
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: KMS_ENDPOINT
- name: KMS_KEY_ID
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: KMS_KEY_ID
{{- if .Values.external.kms.enabled }}
- name: KMS_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ .Values.external.kms.existingSecret.name | quote }}
      key: {{ .Values.external.kms.existingSecret.tokenKey | quote }}
{{- end }}
{{- if .Values.external.vault.enabled }}
- name: VAULT_ADDR
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: VAULT_ADDR
- name: VAULT_NAMESPACE
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: VAULT_NAMESPACE
- name: HELIX_VAULT_AUTH_PATH
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: HELIX_VAULT_AUTH_PATH
- name: HELIX_VAULT_ROLE
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: HELIX_VAULT_ROLE
- name: HELIX_BYO_STORAGE_VAULT_MOUNT
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: HELIX_BYO_STORAGE_VAULT_MOUNT
- name: HELIX_BYO_STORAGE_VAULT_KV_VERSION
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: HELIX_BYO_STORAGE_VAULT_KV_VERSION
{{- end }}
{{- if .Values.external.siem.enabled }}
- name: SIEM_ENDPOINT
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: SIEM_ENDPOINT
- name: SIEM_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ .Values.external.siem.existingSecret.name | quote }}
      key: {{ .Values.external.siem.existingSecret.tokenKey | quote }}
{{- end }}
{{- with .Values.env }}
{{- toYaml . }}
{{- end }}
{{- end -}}

{{/*
helix.roleEnv renders the HELIX_ROLE / HELIX_APPS env entries for an extra
role-based Deployment. Input is the per-role spec from .Values.roleDeployments.
An explicit `apps` list takes precedence over a named `role`.
*/}}
{{- define "helix.roleEnv" -}}
{{- if .apps }}
- name: HELIX_APPS
  value: {{ .apps | quote }}
{{- else if .role }}
- name: HELIX_ROLE
  value: {{ .role | quote }}
{{- end }}
{{- end -}}

{{- define "helix.cloudnativepgObjectStore" -}}
{{- $store := . -}}
destinationPath: {{ required "cloudnativepg.backup.barmanObjectStore.destinationPath is required when CloudNativePG backup is enabled" $store.destinationPath | quote }}
{{- with $store.endpointURL }}
endpointURL: {{ . | quote }}
{{- end }}
{{- with $store.serverName }}
serverName: {{ . | quote }}
{{- end }}
{{- $creds := $store.s3Credentials -}}
{{- if or $creds.inheritFromIAMRole $creds.accessKeyId.name $creds.secretAccessKey.name $creds.sessionToken.name }}
s3Credentials:
  {{- if $creds.inheritFromIAMRole }}
  inheritFromIAMRole: true
  {{- end }}
  {{- with $creds.accessKeyId.name }}
  accessKeyId:
    name: {{ . | quote }}
    key: {{ $creds.accessKeyId.key | quote }}
  {{- end }}
  {{- with $creds.secretAccessKey.name }}
  secretAccessKey:
    name: {{ . | quote }}
    key: {{ $creds.secretAccessKey.key | quote }}
  {{- end }}
  {{- with $creds.sessionToken.name }}
  sessionToken:
    name: {{ . | quote }}
    key: {{ $creds.sessionToken.key | quote }}
  {{- end }}
{{- end }}
{{- with $store.wal }}
wal:
  {{- with .compression }}
  compression: {{ . | quote }}
  {{- end }}
  {{- with .encryption }}
  encryption: {{ . | quote }}
  {{- end }}
  {{- with .maxParallel }}
  maxParallel: {{ . }}
  {{- end }}
  {{- with .additionalCommandArgs }}
  additionalCommandArgs:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end }}
{{- with $store.data }}
data:
  {{- with .compression }}
  compression: {{ . | quote }}
  {{- end }}
  {{- with .encryption }}
  encryption: {{ . | quote }}
  {{- end }}
  {{- with .jobs }}
  jobs: {{ . }}
  {{- end }}
  {{- with .additionalCommandArgs }}
  additionalCommandArgs:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end }}
{{- with $store.tags }}
tags:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $store.historyTags }}
historyTags:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}
