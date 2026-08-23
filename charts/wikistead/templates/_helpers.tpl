{{/* The release's name for a resource. Kept short: these names appear in Service DNS. */}}
{{- define "wikistead.fullname" -}}
{{- if .Values.fullnameOverride }}{{ .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}{{ .Release.Name | trunc 63 | trimSuffix "-" }}{{ end }}
{{- end }}

{{- define "wikistead.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
One image reference.

⚠️ A digest wins over a tag when both are given (ADR-162 §2). A tag is a name somebody can move; a
digest is the thing that ran, and a production install should be pinning it. Written as one helper so
the rule cannot differ between the three services — the kind of drift that shows up as "two of the
three pods upgraded".
*/}}
{{- define "wikistead.image" -}}
{{- $svc := index . 0 -}}{{- $root := index . 1 -}}
{{- $digest := $svc.image.digest | default $root.Values.image.digest -}}
{{- $tag := $svc.image.tag | default $root.Values.image.tag | default $root.Chart.AppVersion -}}
{{- $repo := printf "%s/%s" (trimSuffix "/" $root.Values.image.registry) $svc.image.repository -}}
{{- if $digest }}{{ printf "%s@%s" $repo $digest }}{{ else }}{{ printf "%s:%s" $repo $tag }}{{ end }}
{{- end }}

{{/* Where the application reaches each middleware: the bundled Service, or what the operator gave. */}}
{{- define "wikistead.postgresUrl" -}}
{{- if .Values.postgres.externalUrl }}{{ .Values.postgres.externalUrl }}
{{- else }}postgres://app:app@{{ include "wikistead.fullname" . }}-postgres:5432/app{{ end }}
{{- end }}
{{- define "wikistead.valkeyUrl" -}}
{{- if .Values.valkey.externalUrl }}{{ .Values.valkey.externalUrl }}
{{- else }}redis://{{ include "wikistead.fullname" . }}-valkey:6379{{ end }}
{{- end }}
{{- define "wikistead.openfgaApiUrl" -}}
{{- if .Values.openfga.externalApiUrl }}{{ .Values.openfga.externalApiUrl }}
{{- else }}http://{{ include "wikistead.fullname" . }}-openfga:8080{{ end }}
{{- end }}
{{- define "wikistead.meiliHost" -}}
{{- if .Values.meilisearch.externalHost }}{{ .Values.meilisearch.externalHost }}
{{- else }}http://{{ include "wikistead.fullname" . }}-meilisearch:7700{{ end }}
{{- end }}
{{- define "wikistead.s3Endpoint" -}}
{{- if .Values.seaweedfs.externalEndpoint }}{{ .Values.seaweedfs.externalEndpoint }}
{{- else }}http://{{ include "wikistead.fullname" . }}-seaweedfs:9000{{ end }}
{{- end }}

{{/*
#912: the public name of the in-chart object store (empty when storage is external: managed S3/R2 is
reached by the browser at its own address, so the server signs with S3_ENDPOINT as before).
*/}}
{{- define "wikistead.s3PublicHost" -}}
{{- if .Values.seaweedfs.externalEndpoint }}{{ "" }}
{{- else if .Values.seaweedfs.publicHost }}{{ .Values.seaweedfs.publicHost }}
{{- else }}s3.{{ .Values.host }}{{ end }}
{{- end }}
