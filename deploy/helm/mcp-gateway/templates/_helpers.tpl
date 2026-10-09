{{- define "mcp-gateway.fullname" -}}
{{- if contains .Chart.Name .Release.Name -}}{{ .Release.Name | trunc 53 | trimSuffix "-" }}{{- else -}}{{ printf "%s-%s" .Release.Name .Chart.Name | trunc 53 | trimSuffix "-" }}{{- end -}}
{{- end -}}

{{- define "mcp-gateway.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "mcp-gateway.labels" -}}
{{ include "mcp-gateway.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "mcp-gateway.image" -}}
{{ .Values.image.repository }}:{{ default .Chart.AppVersion .Values.image.tag }}
{{- end -}}

{{/* Name of the chart-managed Secret holding MCP_GATEWAY_API_KEYS (when .Values.apiKeys is set). */}}
{{- define "mcp-gateway.apiKeysSecret" -}}
{{ include "mcp-gateway.fullname" . }}-api-keys
{{- end -}}

{{/* True ("true") when the gateway config itself provides authentication. */}}
{{- define "mcp-gateway.configAuth" -}}
{{- $auth := default dict .Values.config.auth -}}
{{- $cp := default dict .Values.config.controlPlane -}}
{{- if or (and $auth.strategy (ne (toString $auth.strategy) "none")) (eq (toString $cp.role) "data") -}}true{{- end -}}
{{- end -}}

{{/*
10.3: an API key is required by default. Fail fast at template / install time instead of shipping pods that refuse
to start (or, before 10.3, an open gateway).
*/}}
{{- define "mcp-gateway.validateAuth" -}}
{{- if not (or .Values.existingSecret .Values.apiKeys (include "mcp-gateway.configAuth" .) (.Values.security).insecure) -}}
{{- fail "\n\nmcp-gateway: an API key is required (chart >= 10.3.0).\nCreate a Secret containing MCP_GATEWAY_API_KEYS and pass it as existingSecret:\n  kubectl create secret generic gw-secrets --from-literal=MCP_GATEWAY_API_KEYS=<key>\n  helm install <release> ./deploy/helm/mcp-gateway --set existingSecret=gw-secrets\nAlternatives: --set apiKeys={<key>} (chart-managed Secret) or config.auth (e.g. jwt).\nTo run WITHOUT authentication on a trusted network only: --set security.insecure=true\n" -}}
{{- end -}}
{{- end -}}
