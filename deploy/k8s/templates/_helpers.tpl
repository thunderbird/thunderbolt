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
