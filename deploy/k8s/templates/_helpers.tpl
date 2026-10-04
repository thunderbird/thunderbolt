{{/*
Chart name, truncated to 63 chars.
*/}}
{{- define "thunderbolt.name" -}}
{{- .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fullname: release-chart, truncated to 63 chars.
*/}}
{{- define "thunderbolt.fullname" -}}
{{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels applied to all resources.
*/}}
{{- define "thunderbolt.labels" -}}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/instance: {{ .Release.Name }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{/*
Image pull secrets block.
*/}}
{{- define "thunderbolt.imagePullSecrets" -}}
{{- if .Values.imagePullSecrets }}
imagePullSecrets:
{{- range .Values.imagePullSecrets }}
  - name: {{ .name }}
{{- end }}
{{- end }}
{{- end -}}

{{/*
Pod annotations block. Merges per-component annotations with the chart-wide
`podAnnotations`. Sprig `merge` is dst-wins, so per-component keys take
precedence over chart-wide keys. Renders the full `annotations:` YAML key (or
nothing, if both maps are empty).

Usage:
  {{- include "thunderbolt.podAnnotations" (dict "component" .Values.backend "root" .) | nindent 6 }}
*/}}
{{- define "thunderbolt.podAnnotations" -}}
{{- $merged := merge (deepCopy (.component.podAnnotations | default dict)) (.root.Values.podAnnotations | default dict) -}}
{{- if $merged }}
annotations:
  {{- toYaml $merged | nindent 2 }}
{{- end }}
{{- end -}}

{{/*
Node selector block. Renders the full `nodeSelector:` YAML key (or nothing,
if `.Values.nodeSelector` is empty). Useful to pin workloads to a particular
node pool, e.g. `kubernetes.io/arch: amd64` to keep them off arm64 nodes, or a
label of your own for a dedicated pool.

Usage:
  {{- include "thunderbolt.nodeSelector" . | nindent 6 }}
*/}}
{{- define "thunderbolt.nodeSelector" -}}
{{- with .Values.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/*
Resources block. Renders the full `resources:` YAML key (or nothing, if the
component has no `resources` set).

Usage:
  {{- include "thunderbolt.resources" .Values.backend.resources | nindent 10 }}
*/}}
{{- define "thunderbolt.resources" -}}
{{- with . }}
resources:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/*
OIDC configuration guards. Four misconfigurations render cleanly and then
fail only at first sign-in, so reject them here instead:
  - keycloak.enabled=false with no oidc.issuer points the backend at a
    Service that no longer exists in the release.
  - oidc.discoveryUrl without oidc.issuer leaves the provider's origin out
    of TRUSTED_ORIGINS, so Better Auth rejects it.
  - oidc.issuer without its own clientId/clientSecretBase64 silently falls
    back to the bundled Keycloak client, whose secret is published in
    this repo.
  - oidc.clientId/clientSecretBase64 without oidc.issuer sends those
    credentials to the bundled Keycloak instead, which rejects them.

Usage (call once, before anything else renders):
  {{- include "thunderbolt.validateOidc" . }}
*/}}
{{- define "thunderbolt.validateOidc" -}}
{{- $external := ne (.Values.oidc.issuer | default "") "" }}
{{- if and (not .Values.keycloak.enabled) (not $external) }}
  {{- fail "keycloak.enabled=false requires oidc.issuer: the backend has no identity provider to point at." }}
{{- end }}
{{- if and (.Values.oidc.discoveryUrl) (not $external) }}
  {{- fail "oidc.discoveryUrl requires oidc.issuer: without it the provider's origin is never added to TRUSTED_ORIGINS and sign-in fails." }}
{{- end }}
{{- if $external }}
  {{- if not .Values.oidc.clientId }}{{- fail "oidc.issuer requires oidc.clientId: the bundled Keycloak client id is not valid at an external provider." }}{{- end }}
  {{- if not .Values.oidc.clientSecretBase64 }}{{- fail "oidc.issuer requires oidc.clientSecretBase64: the bundled Keycloak client secret is published in this repository and must not be sent to your provider." }}{{- end }}
{{- else }}
  {{- if or .Values.oidc.clientId .Values.oidc.clientSecretBase64 }}
    {{- fail "oidc.clientId/oidc.clientSecretBase64 require oidc.issuer: without it they are sent to the bundled Keycloak, which rejects them. Use keycloak.oidc.clientId/clientSecretBase64 for the bundled Keycloak instead." }}
  {{- end }}
{{- end }}
{{- end -}}
