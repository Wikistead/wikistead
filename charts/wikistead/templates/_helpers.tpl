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

⚠️ A digest wins over a tag when both are given. A tag is a name somebody can move; a
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
The public name of the in-chart object store (empty when storage is external: managed S3/R2 is
reached by the browser at its own address, so the server signs with S3_ENDPOINT as before).
*/}}
{{- define "wikistead.s3PublicHost" -}}
{{- if .Values.seaweedfs.externalEndpoint }}{{ "" }}
{{- else if .Values.seaweedfs.publicHost }}{{ .Values.seaweedfs.publicHost }}
{{- else }}s3.{{ .Values.host }}{{ end }}
{{- end }}

{{/*
The content of the shared ConfigMap and Secret, for a pod-template checksum annotation.

⚠️ `envFrom` (and a `secretKeyRef` into either object) is read once, at container start.
`helm upgrade` changing a value inside them changes the ConfigMap/Secret in place, reports
"successfully rolled out", and leaves the pod running with the OLD value — there is nothing in the
Deployment's own spec for Kubernetes to diff (measured on a real cluster: changing
`workspaceHostTemplate` left the pod's start time untouched, and only a manual `rollout restart`
picked it up). Hashing both
rendered manifests into an annotation gives the pod template a field that actually changes when their
content does, which is what triggers the rollout.
*/}}
{{- define "wikistead.envChecksum" -}}
{{ include (print $.Template.BasePath "/config.yaml") . }}
{{ include (print $.Template.BasePath "/secret.yaml") . }}
{{- end }}

{{/*
Fails the render, before any manifest is written, when `workspaceHostTemplate` does not match what
`ingress.wildcardHost` actually serves.

Measured on a real cluster: `values.yaml`'s own example (`https://{slug}.example.com`, one label
SHALLOWER than the default `host: wikistead.example.com`) resolved to nothing — only the deep
`{slug}.<host>` form, the one the `*.<host>` wildcard rule (`templates/ingress.yaml`) actually routes,
worked. Nothing compared the two, so the mismatch only surfaced as a 404 in the browser.
*/}}
{{- define "wikistead.validateWorkspaceHostTemplate" -}}
{{- if .Values.workspaceHostTemplate }}
{{- if not .Values.ingress.wildcardHost }}
{{- fail (printf "workspaceHostTemplate is set to %q but ingress.wildcardHost is false, so nothing serves the wildcard a workspace address needs. Set ingress.wildcardHost: true, or unset workspaceHostTemplate to keep self-serve creation closed." .Values.workspaceHostTemplate) }}
{{- end }}
{{- $host := .Values.workspaceHostTemplate }}
{{- $host = trimPrefix "https://" $host }}
{{- $host = trimPrefix "http://" $host }}
{{- $host = splitList "/" $host | first }}
{{- $host = splitList ":" $host | first }}
{{- $expected := printf "{slug}.%s" .Values.host }}
{{- if ne $host $expected }}
{{- fail (printf "workspaceHostTemplate's host (%s) does not match %s, which is the one shape ingress.wildcardHost's *.%s rule actually routes. Set workspaceHostTemplate to https://%s (keeping your own scheme/port)." $host $expected .Values.host $expected) }}
{{- end }}
{{- end }}
{{- end }}
