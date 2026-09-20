{{- define "adk-agent.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "adk-agent.fullname" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "adk-agent.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "adk-agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/component: agent
a2a.lab/app-name: {{ .Values.appName }}
{{- end -}}

{{- define "adk-agent.selectorLabels" -}}
app.kubernetes.io/name: {{ include "adk-agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "adk-agent.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "adk-agent.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
The in-cluster base URL other agents use to reach this one. Kept in one place
so a card and a route cannot drift apart.
*/}}
{{- define "adk-agent.clusterURL" -}}
http://{{ include "adk-agent.fullname" . }}.{{ .Release.Namespace }}.svc.cluster.local:{{ .Values.service.port }}
{{- end -}}
