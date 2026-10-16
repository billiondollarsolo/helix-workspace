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

{{/*
The optional password manager is its own workload: its labels must never match
helix.selectorLabels, or the application's Service, HPA and network policies
would select it.
*/}}
{{- define "helix.passwords.selectorLabels" -}}
app.kubernetes.io/name: {{ printf "%s-passwords" (include "helix.name" .) }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "helix.passwords.labels" -}}
helm.sh/chart: {{ include "helix.chart" . }}
{{ include "helix.passwords.selectorLabels" . }}
app.kubernetes.io/component: passwords
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: helix
{{- end -}}

{{/*
Default pod scheduling keeps replicas off the same node and spreads them across
zones while still permitting a single-zone development cluster. Callers may
replace affinity or topologySpreadConstraints explicitly.
*/}}
{{- define "helix.podScheduling" -}}
{{- $root := .root -}}
{{- $role := .role -}}
{{- with $root.Values.availability.priorityClassName }}
priorityClassName: {{ . | quote }}
{{- end }}
affinity:
  {{- if .affinity }}
  {{- toYaml .affinity | nindent 2 }}
  {{- else }}
  podAntiAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      - weight: 100
        podAffinityTerm:
          topologyKey: kubernetes.io/hostname
          labelSelector:
            matchLabels:
              {{- include "helix.selectorLabels" $root | nindent 14 }}
              helix.io/role: {{ $role | quote }}
  {{- end }}
topologySpreadConstraints:
  {{- if .topologySpreadConstraints }}
  {{- toYaml .topologySpreadConstraints | nindent 2 }}
  {{- else }}
  - maxSkew: 1
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: ScheduleAnyway
    labelSelector:
      matchLabels:
        {{- include "helix.selectorLabels" $root | nindent 8 }}
        helix.io/role: {{ $role | quote }}
  - maxSkew: 1
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: ScheduleAnyway
    labelSelector:
      matchLabels:
        {{- include "helix.selectorLabels" $root | nindent 8 }}
        helix.io/role: {{ $role | quote }}
  {{- end }}
{{- end -}}

{{- define "helix.selectedImageRepository" -}}
{{- ternary .Values.fips.imageRepository .Values.image.repository .Values.fips.enabled -}}
{{- end -}}

{{- define "helix.selectedImageDigest" -}}
{{- ternary .Values.fips.imageDigest .Values.image.digest .Values.fips.enabled -}}
{{- end -}}

{{- define "helix.image" -}}
{{- $repository := include "helix.selectedImageRepository" . -}}
{{- $digest := required "image.digest or fips.imageDigest must be an approved sha256 digest" (include "helix.selectedImageDigest" .) -}}
{{- printf "%s@%s" $repository $digest -}}
{{- end -}}

{{- define "helix.validateValues" -}}
{{- $digest := required "image.digest or fips.imageDigest must be an approved sha256 digest" (include "helix.selectedImageDigest" .) -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $digest) -}}
{{- fail "selected image digest must match sha256:<64 lowercase hex characters>" -}}
{{- end -}}
{{- if eq $digest "sha256:0000000000000000000000000000000000000000000000000000000000000000" -}}
{{- fail "selected image digest cannot be a placeholder" -}}
{{- end -}}
{{- if not (regexMatch "^https://[^/?#@]+/?$" .Values.publicUrl) -}}
{{- fail "publicUrl must be one canonical HTTPS origin without credentials, path, query, or fragment" -}}
{{- end -}}
{{- if not (regexMatch "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$" .Values.external.s3.region) -}}
{{- fail "external.s3.region must be the canonical lowercase deployment region" -}}
{{- end -}}
{{- if and .Values.cloudnativepg.backup.enabled (not (contains .Values.external.s3.region .Values.cloudnativepg.backup.barmanObjectStore.destinationPath)) -}}
{{- fail "cloudnativepg backup destinationPath must include the deployment region" -}}
{{- end -}}
{{- if hasKey .Values.cloudnativepg.backup.barmanObjectStore.wal "additionalCommandArgs" -}}
{{- fail "cloudnativepg.backup.barmanObjectStore.wal.additionalCommandArgs is not a Barman Cloud field; use wal.archiveAdditionalCommandArgs (and restoreAdditionalCommandArgs)" -}}
{{- end -}}
{{- if hasKey .Values.cloudnativepg "imageName" -}}
{{- fail "cloudnativepg.imageName is unsupported; set cloudnativepg.image.repository and cloudnativepg.image.digest (PostgreSQL 18 with pgvector, pinned by digest)" -}}
{{- end -}}
{{- if .Values.cloudnativepg.enabled -}}
{{- $cnpg := .Values.cloudnativepg -}}
{{- if $cnpg.bootstrap.recovery.enabled -}}
{{- with $cnpg.bootstrap.recovery.recoveryTarget -}}
{{- if and (or .targetName .targetLSN .targetXID) (not .backupID) -}}
{{- fail "cloudnativepg.bootstrap.recovery.recoveryTarget.backupID is required with targetName, targetLSN or targetXID" -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if not (regexMatch "^18\\.[0-9]+([-.][a-zA-Z0-9.-]+)?$" $cnpg.image.tag) -}}
{{- fail "cloudnativepg.image.tag must identify PostgreSQL 18 (for example 18.6); image.digest still pins the image" -}}
{{- end -}}
{{- if lt (int $cnpg.instances) 1 -}}
{{- fail "cloudnativepg.instances must be positive" -}}
{{- end -}}
{{- if not (has $cnpg.podAntiAffinityType (list "required" "preferred")) -}}
{{- fail "cloudnativepg.podAntiAffinityType must be required or preferred" -}}
{{- end -}}
{{- with $cnpg.postgresql.synchronous -}}
{{- if or (not (has .method (list "any" "first"))) (not (has .dataDurability (list "required" "preferred"))) (lt (int .number) 1) (ge (int .number) (int $cnpg.instances)) -}}
{{- fail "cloudnativepg.postgresql.synchronous requires method any/first, dataDurability required/preferred, and 1 <= number < instances" -}}
{{- end -}}
{{- end -}}
{{- $_ := required "cloudnativepg.networkPolicy.operatorNamespace is required" $cnpg.networkPolicy.operatorNamespace -}}
{{- if not $cnpg.networkPolicy.operatorPodLabels -}}
{{- fail "cloudnativepg.networkPolicy.operatorPodLabels must select the operator" -}}
{{- end -}}
{{- $cnpgDigest := required "cloudnativepg.image.digest must be the published helix-workspace-postgres-cnpg sha256 digest" .Values.cloudnativepg.image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $cnpgDigest) -}}
{{- fail "cloudnativepg.image.digest must match sha256:<64 lowercase hex characters>" -}}
{{- end -}}
{{- if eq $cnpgDigest "sha256:0000000000000000000000000000000000000000000000000000000000000000" -}}
{{- fail "cloudnativepg.image.digest cannot be a placeholder" -}}
{{- end -}}
{{- if not (regexMatch "^[a-z_][a-z0-9_]{0,62}$" .Values.cloudnativepg.bootstrap.owner) -}}
{{- fail "cloudnativepg.bootstrap.owner must be a lowercase PostgreSQL identifier" -}}
{{- end -}}
{{- if has .Values.cloudnativepg.bootstrap.owner (list "postgres" "helix_migration_owner" "helix_app" "helix_worker" "helix_readonly") -}}
{{- fail "cloudnativepg.bootstrap.owner must be the dedicated migration login (helix_migrator), not a superuser or a Helix runtime role" -}}
{{- end -}}
{{- end -}}
{{- if .Values.external.postgres.url -}}
{{- fail "external.postgres.url is unsupported in production; use external.postgres.urlSecret" -}}
{{- end -}}
{{- $_ := required "external.postgres.urlSecret.name is required" .Values.external.postgres.urlSecret.name -}}
{{- $_ := required "external.postgres.urlSecret.key is required" .Values.external.postgres.urlSecret.key -}}
{{- $_ := required "auth.secretRef.name is required" .Values.auth.secretRef.name -}}
{{- $_ := required "auth.secretRef.key is required" .Values.auth.secretRef.key -}}
{{- $_ := required "external.meilisearch.masterKeySecret.name is required" .Values.external.meilisearch.masterKeySecret.name -}}
{{- $_ := required "external.s3.accessKeySecret.name is required" .Values.external.s3.accessKeySecret.name -}}
{{- $_ := required "external.s3.secretKeySecret.name is required" .Values.external.s3.secretKeySecret.name -}}
{{- $networkPolicy := .Values.networkPolicy -}}
{{- if hasKey $networkPolicy "enabled" -}}
{{- fail "networkPolicy.enabled is unsupported; workload network policies are mandatory" -}}
{{- end -}}
{{- if or (hasKey $networkPolicy "ingress") (hasKey $networkPolicy "egress") -}}
{{- fail "legacy networkPolicy.ingress/egress is unsupported; use application or imageVerifier policies" -}}
{{- end -}}
{{- if not $networkPolicy.dns.enabled -}}
{{- fail "networkPolicy.dns.enabled must remain true so workloads have only exact DNS egress by default" -}}
{{- end -}}
{{- $_ := required "networkPolicy.dns.namespace is required" $networkPolicy.dns.namespace -}}
{{- if eq (len $networkPolicy.dns.podLabels) 0 -}}
{{- fail "networkPolicy.dns.podLabels must select the DNS workload exactly" -}}
{{- end -}}
{{- range $reservedLabel := list "app.kubernetes.io/name" "app.kubernetes.io/instance" "helix.io/role" "helix.io/service-account" -}}
{{- if hasKey $.Values.podLabels $reservedLabel -}}
{{- fail (printf "podLabels may not override reserved network identity label %s" $reservedLabel) -}}
{{- end -}}
{{- end -}}
{{- if $networkPolicy.imageVerifier.ingress -}}
{{- fail "networkPolicy.imageVerifier ingress must remain empty" -}}
{{- end -}}
{{- if and .Values.ingress.enabled (not $networkPolicy.application.ingress) -}}
{{- fail "ingress.enabled requires at least one exact networkPolicy.application.ingress source" -}}
{{- end -}}
{{- $policies := dict "application" $networkPolicy.application "imageVerifier" $networkPolicy.imageVerifier "roleDefault" $networkPolicy.roleDefault "migrate" $networkPolicy.migrate -}}
{{- if $networkPolicy.migrate.ingress -}}
{{- fail "networkPolicy.migrate ingress must remain empty" -}}
{{- end -}}
{{- if $networkPolicy.migrate.egress.publicHttps -}}
{{- fail "networkPolicy.migrate egress is DNS, PostgreSQL, and exact secret-store endpoints only; publicHttps is not allowed" -}}
{{- end -}}
{{- range $role := .Values.roleDeployments -}}
{{- $_ := set $policies (printf "roleDeployments.%s.networkPolicy" $role.name) ($role.networkPolicy | default $networkPolicy.roleDefault) -}}
{{- end -}}
{{- range $policyName, $policy := $policies -}}
{{- range $source := $policy.ingress -}}
{{- $_ := required (printf "networkPolicy.%s ingress namespace is required" $policyName) $source.namespace -}}
{{- $_ := required (printf "networkPolicy.%s ingress serviceAccount is required" $policyName) $source.serviceAccount -}}
{{- if eq (len ($source.podLabels | default dict)) 0 -}}
{{- fail (printf "networkPolicy.%s ingress podLabels must select the source workload exactly" $policyName) -}}
{{- end -}}
{{- if hasKey $source.podLabels "helix.io/service-account" -}}
{{- fail (printf "networkPolicy.%s ingress podLabels may not override helix.io/service-account" $policyName) -}}
{{- end -}}
{{- end -}}
{{- $egress := $policy.egress -}}
{{- if or (hasKey $egress "allowAll") (hasKey $egress "cidrs") (hasKey $egress "ports") -}}
{{- fail (printf "networkPolicy.%s legacy broad egress keys are unsupported" $policyName) -}}
{{- end -}}
{{- range $destination := $egress.endpoints -}}
{{- $cidr := required (printf "networkPolicy.%s endpoint cidr is required" $policyName) $destination.cidr -}}
{{- $normalizedCidr := lower $cidr -}}
{{- if not (regexMatch "^.+/(32|128)$" $cidr) -}}
{{- fail (printf "networkPolicy.%s endpoint %s must identify one host (/32 or /128)" $policyName $cidr) -}}
{{- end -}}
{{- if or (regexMatch "^(0|127|169\\.254)\\." $normalizedCidr) (regexMatch "^(::|::1/|fe80:|fd00:ec2::254/|fd20:ce::254/)" $normalizedCidr) (eq $normalizedCidr "100.100.100.200/32") -}}
{{- fail (printf "networkPolicy.%s endpoint %s targets a local or metadata address" $policyName $cidr) -}}
{{- end -}}
{{- if eq (len ($destination.ports | default list)) 0 -}}
{{- fail (printf "networkPolicy.%s endpoint %s requires exact ports" $policyName $cidr) -}}
{{- end -}}
{{- range $port := $destination.ports -}}
{{- if or (lt (int $port) 1) (gt (int $port) 65535) -}}
{{- fail (printf "networkPolicy.%s endpoint port must be between 1 and 65535" $policyName) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- range $destination := $egress.inCluster -}}
{{- $_ := required (printf "networkPolicy.%s inCluster namespace is required" $policyName) $destination.namespace -}}
{{- $_ := required (printf "networkPolicy.%s inCluster serviceAccount is required" $policyName) $destination.serviceAccount -}}
{{- if eq (len ($destination.podLabels | default dict)) 0 -}}
{{- fail (printf "networkPolicy.%s inCluster podLabels must select the destination workload exactly" $policyName) -}}
{{- end -}}
{{- if hasKey $destination.podLabels "helix.io/service-account" -}}
{{- fail (printf "networkPolicy.%s inCluster podLabels may not override helix.io/service-account" $policyName) -}}
{{- end -}}
{{- if eq (len ($destination.ports | default list)) 0 -}}
{{- fail (printf "networkPolicy.%s inCluster destination requires exact ports" $policyName) -}}
{{- end -}}
{{- range $port := $destination.ports -}}
{{- if or (lt (int $port) 1) (gt (int $port) 65535) -}}
{{- fail (printf "networkPolicy.%s inCluster port must be between 1 and 65535" $policyName) -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- /* Optional password manager: everything it cannot run without, checked before anything renders. */ -}}
{{- if .Values.passwords.enabled -}}
{{- if not .Values.passwords.host -}}
{{- fail "passwords.host is required when passwords.enabled is true (for example vault.example.com)" -}}
{{- end -}}
{{- if not .Values.passwords.signupDomains -}}
{{- fail "passwords.signupDomains is required when passwords.enabled is true: the email domains allowed to create a vault account" -}}
{{- end -}}
{{- if or (not .Values.passwords.smtp.host) (not .Values.passwords.smtp.from) -}}
{{- fail "passwords.smtp.host and passwords.smtp.from are required when passwords.enabled is true: sign-up is confirmed by email" -}}
{{- end -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" .Values.passwords.image.digest) -}}
{{- fail "passwords.image.digest must be a sha256 digest" -}}
{{- end -}}
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
# The production image-pinning check: a Helm release pins the image it runs.
- name: HELIX_DEPLOYMENT_KIND
  value: helm
- name: HELIX_IMAGE
  value: {{ include "helix.image" . | quote }}
- name: HOST
  value: 0.0.0.0
- name: PORT
  value: "3000"
- name: HELIX_REGION
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: HELIX_REGION
- name: HELIX_OTEL_REGION
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: HELIX_OTEL_REGION
- name: HELIX_SIEM_REGION
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: HELIX_SIEM_REGION
- name: MEET_JITSI_REGION
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: MEET_JITSI_REGION
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
- name: HELIX_TENANT_ROOT_HOSTS
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: HELIX_TENANT_ROOT_HOSTS
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
{{- if .Values.passwords.enabled }}
- name: HELIX_PASSWORDS_URL
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: HELIX_PASSWORDS_URL
{{- end }}
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
- name: BETTER_AUTH_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ .Values.auth.secretRef.name | quote }}
      key: {{ .Values.auth.secretRef.key | quote }}
- name: DATABASE_URL
  {{- if .Values.external.postgres.url }}
  value: {{ .Values.external.postgres.url | quote }}
  {{- else }}
  valueFrom:
    secretKeyRef:
      name: {{ required "external.postgres.urlSecret.name is required when external.postgres.url is empty" .Values.external.postgres.urlSecret.name | quote }}
      key: {{ .Values.external.postgres.urlSecret.key | quote }}
  {{- end }}
- name: POSTGRES_TLS_CA_FILE
  value: /var/run/helix/postgres-tls/ca.crt
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
{{- if .Values.external.clamav.enabled }}
- name: MAIL_CLAMAV_ENABLED
  value: "true"
- name: MAIL_CLAMAV_HOST
  value: {{ required "external.clamav.host is required" .Values.external.clamav.host | quote }}
- name: MAIL_CLAMAV_PORT
  value: {{ .Values.external.clamav.port | quote }}
- name: MAIL_CLAMAV_TIMEOUT_MS
  value: {{ .Values.external.clamav.timeoutMs | quote }}
- name: HELIX_AV_MAX_SIGNATURE_AGE_MS
  value: {{ .Values.external.clamav.maxSignatureAgeMs | quote }}
{{- end }}
- name: RUSTFS_ENDPOINT
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" . }}-config
      key: RUSTFS_ENDPOINT
{{- range $key := list "RUSTFS_BUCKET" "RUSTFS_REGION" "RUSTFS_SERVER_SIDE_ENCRYPTION" "RUSTFS_SSE_KMS_KEY_ID" "RUSTFS_OBJECT_LOCK_MODE" "RUSTFS_OBJECT_LOCK_RETENTION_DAYS" }}
- name: {{ $key }}
  valueFrom:
    configMapKeyRef:
      name: {{ include "helix.fullname" $ }}-config
      key: {{ $key }}
{{- end }}
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
{{ with .Values.env }}
{{ toYaml . }}
{{ end }}
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

{{- define "helix.cloudnativepgImage" -}}
{{- $image := .Values.cloudnativepg.image -}}
{{- $digest := required "cloudnativepg.image.digest must be the published helix-workspace-postgres-cnpg sha256 digest" $image.digest -}}
{{- printf "%s:%s@%s" $image.repository $image.tag $digest -}}
{{- end -}}

{{- define "helix.cloudnativepgClientTls" -}}
{{- if and .Values.cloudnativepg.enabled .Values.cloudnativepg.clientTls.enabled -}}true{{- end -}}
{{- end -}}

{{- /* Share the database CA between application and migration pods. */ -}}
{{- define "helix.postgresTlsVolumeMount" -}}
- name: postgres-tls
  mountPath: /var/run/helix/postgres-tls
  readOnly: true
{{- end -}}

{{- define "helix.postgresTlsVolume" -}}
- name: postgres-tls
  secret:
    {{- if include "helix.cloudnativepgClientTls" . }}
    secretName: {{ printf "%s-ca" .Values.cloudnativepg.clusterName | quote }}
    items:
      - key: ca.crt
        path: ca.crt
    {{- else }}
    secretName: {{ required "external.postgres.caSecret.name is required" .Values.external.postgres.caSecret.name | quote }}
    items:
      - key: {{ required "external.postgres.caSecret.key is required" .Values.external.postgres.caSecret.key | quote }}
        path: ca.crt
    {{- end }}
{{- end -}}

{{- define "helix.cloudnativepgObjectStoreName" -}}
{{- printf "%s-backup" .Values.cloudnativepg.clusterName -}}
{{- end -}}

{{- /*
  Superuser bootstrap for the CloudNativePG application database. Keep this in
  step with infra/postgres/init/001_extensions.sql and
  infra/postgres/init/002_production_roles.sh (Compose) — the
  postgres-bootstrap contract test compares them. Every extension a migration
  creates is installed here because pgvector is not a trusted extension, and
  the role attributes match migration 0090 exactly so the non-superuser owner
  never needs to run ALTER ROLE. The function grants reproduce the ACLs 0090
  sets when a superuser migrates (extension functions stay superuser-owned, so
  the owner cannot change them later); pg_trgm comes after them because a
  superuser migration first creates it in 0168, after 0090's REVOKE.
*/ -}}
{{- define "helix.cloudnativepgBootstrapSQL" -}}
{{- $owner := .Values.cloudnativepg.bootstrap.owner -}}
- CREATE EXTENSION IF NOT EXISTS vector
- CREATE EXTENSION IF NOT EXISTS pgcrypto
- |
  DO '
  BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ''helix_migration_owner'') THEN
      CREATE ROLE helix_migration_owner NOLOGIN NOSUPERUSER BYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ''helix_app'') THEN
      CREATE ROLE helix_app LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ''helix_worker'') THEN
      CREATE ROLE helix_worker LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ''helix_readonly'') THEN
      CREATE ROLE helix_readonly LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE NOREPLICATION;
    END IF;
  END
  '
- GRANT helix_migration_owner TO {{ $owner }}
- REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC
- GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO helix_migration_owner, helix_app, helix_worker
- CREATE EXTENSION IF NOT EXISTS pg_trgm
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
  {{- with .archiveAdditionalCommandArgs }}
  archiveAdditionalCommandArgs:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .restoreAdditionalCommandArgs }}
  restoreAdditionalCommandArgs:
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
