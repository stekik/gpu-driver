#!/usr/bin/env zx

const allTxt = await fs.readFile(path.join(__dirname, '../../config/dist/all.yaml'))
const all = YAML.parseAllDocuments(allTxt.toString()).map(d => d.toJSON())

const fixedName = 'gpu-driver'

function replaceName(value) {
    let result = value
    if (result.startsWith(fixedName)) {
        result = result.slice(fixedName.length)
        result = `{{ template "chart.fullname" . }}` + result
    }
    return result
}

function classify(doc) {
    if (doc.kind === 'ConfigMap' && doc.metadata.name.includes('-scripts')) {
        return 'scripts'
    }
    if (doc.metadata.labels &&
        doc.metadata.labels['app.kubernetes.io/name'] &&
        doc.metadata.labels['app.kubernetes.io/name'].includes('installer')
    ) {
        return 'installer';
    }
    if (doc.kind === 'ConfigMap' && doc.metadata.name.includes('-config')) {
        return 'config';
    }
    switch (doc.kind) {
        case 'CustomResourceDefinition':
            return 'crd'
        case 'Namespace':
            return 'ns'
        case 'Deployment':
            return 'deployment'
        case 'ServiceAccount':
        case 'Role':
        case 'ClusterRole':
        case 'RoleBinding':
        case 'ClusterRoleBinding':
            return 'rbac';
    }
    return '_etc'
}

function testProp(cb) {
    try {
        cb()
        return true
    } catch {}
    return false
}

function wrapWith(content, start, end) {
    return `${start}

${content}

${end}
`
}

const out = {
    _etc: []
}

let image = ''

for (let doc of all) {
    doc.metadata.name = replaceName(doc.metadata.name)
    if (doc.metadata.labels) {
        delete doc.metadata.labels['app.kubernetes.io/managed-by']
        if (doc.metadata.labels['app.kubernetes.io/name']) {
            doc.metadata.labels['app.kubernetes.io/name'] = replaceName(doc.metadata.labels['app.kubernetes.io/name'])
        }
        if (doc.metadata.labels['app.kubernetes.io/part-of']) {
            doc.metadata.labels['app.kubernetes.io/part-of'] = replaceName(doc.metadata.labels['app.kubernetes.io/part-of'])
        }
    }
    if (doc.metadata.namespace) {
        doc.metadata.namespace = replaceName(doc.metadata.namespace)
    }
    if (testProp(() => doc.spec.selector.matchLabels['app.kubernetes.io/name'])) {
        doc.spec.selector.matchLabels['app.kubernetes.io/name'] = replaceName(doc.spec.selector.matchLabels['app.kubernetes.io/name'])
    }
    if (testProp(() => doc.spec.template.metadata.labels['app.kubernetes.io/name'])) {
        doc.spec.template.metadata.labels['app.kubernetes.io/name'] = replaceName(doc.spec.template.metadata.labels['app.kubernetes.io/name'])
    }
    if (testProp(() => doc.spec.template.spec.volumes)) {
        for (let vol of doc.spec.template.spec.volumes) {
            if (vol.configMap) {
                vol.configMap.name = replaceName(vol.configMap.name)
            }
        }
    }
    if (testProp(() => doc.spec.template.spec.containers)) {
        for (let cont of doc.spec.template.spec.containers) {
            if (cont.name === 'gpu-driver-manager') {
                image = cont.image
                cont.image = `{{ template "manager.image" . }}`
            }
        }
    }

    if (doc.kind === 'Deployment') {
        doc.spec.template.spec.imagePullSecrets = 'imagePullSecretsReplaceMe'
    }

    if (doc.kind === 'CustomResourceDefinition') {
        const templatedDefaults = {
            devicePlugin: ['repository', 'image', 'version'],
            installer: ['repository', 'image'],
        }
        for (const version of doc.spec.versions) {
            const specProps = version.schema.openAPIV3Schema.properties.spec.properties
            for (const [section, fields] of Object.entries(templatedDefaults)) {
                for (const field of fields) {
                    specProps[section].properties[field].default = `{{ .Values.${section}.${field} }}`
                }
            }
        }
    }

    if (doc.kind === 'ClusterRoleBinding') {
        doc.roleRef.name = replaceName(doc.roleRef.name)
        for (let sub of doc.subjects) {
            if (sub.kind === 'ServiceAccount') {
                sub.name = replaceName(sub.name)
                sub.namespace = replaceName(sub.namespace)
            }
        }
    }

    const cls = classify(doc)
    if (!Array.isArray(out[cls])) {
        out[cls] = []
    }
    out[cls].push(YAML.stringify(doc))
}

const chartDir = path.join(__dirname, '../../charts/gpu-driver-operator')
const templateDir = path.join(chartDir, 'templates')

for (let prop in out) {
    if (prop === '_etc' && out[prop].length == 0) {
        continue
    }
    console.log(`${prop}.yaml ${out[prop].length}`)

    let content = out[prop].join("\n---\n")

    if (prop === 'crd') {
        content = wrapWith(content, '{{- if .Values.crd.enabled }}', '{{- end }}')
    }
    if (prop === 'deployment') {
        content = wrapWith(content, '{{- if .Values.manager.enabled }}', '{{- end }}')
        content = content.replace('imagePullSecretsReplaceMe', `{{ template "image-pull-secrets" . }}`)
    }
    if (prop === 'ns') {
        content = wrapWith(content, '{{- if .Values.namespace.create }}', '{{- end }}')
    }

    fs.writeFile(path.join(templateDir, `${prop}.yaml`), content)
}

let hasWarnings = false

if (image === '') {
    hasWarnings = true
    console.log('Warning: Manager image not detected!')
} else {
    let valuesTxt = (await fs.readFile(path.join(chartDir, 'values-template.yaml'))).toString()
    let [uri, tag] = image.split(':')
    let [repo, ...img] = uri.split('/')
    valuesTxt = valuesTxt.replace('<manager-repository>', repo)
    valuesTxt = valuesTxt.replace('<manager-image>', img.join('/'))
    valuesTxt = valuesTxt.replace('<manager-tag>', tag)
    await fs.writeFile(path.join(chartDir, 'values.yaml'), valuesTxt)
}

if (out._etc.length > 0) {
    hasWarnings = true
    console.log('Warning: Unclassified resources in _etc.yaml!');
}

if (hasWarnings) {
    process.exit(1)
}
