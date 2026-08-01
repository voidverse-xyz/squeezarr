export const SUPPORTED_LANGUAGES = [
    { code: "en", label: "English" },
    { code: "es", label: "Español" },
];

export const DEFAULT_LANG = "en";

export const locales = {
    // ─── English ─────────────────────────────────────────────────────────────────
    en: {
        app: { title: "Squeezarr" },

        nav: {
            dashboard: "Dashboard",
            settings: "Settings",
            language: "Language",
        },

        tabs: {
            files: "All Files",
            jobs: "Jobs",
            stats: "Statistics",
            workers: "Workers",
        },

        actions: {
            scan: "Scan",
            scanning: "Scanning…",
            save: "Save",
            saving: "Saving…",
            saved: "Saved!",
            cancel: "Cancel",
            confirm: "Confirm",
            add: "Add",
            update: "Update",
            delete: "Delete",
            replace: "Replace",
            stop: "Stop",
            requeue: "Requeue",
            edit: "Edit",
            retry: "Retry",
            refresh: "Refresh",
            dismiss: "Dismiss",
        },

        auth: {
            checking: "Checking session…",
            signInTitle: "Sign in to continue",
            passwordLabel: "Password",
            signIn: "Sign in",
            signingIn: "Signing in…",
            logout: "Sign out",
            unavailable: "The service is temporarily unavailable. Your session has been kept; try again.",
            errors: {
                unauthorized: "That password didn't work.",
                expired_token: "Your session expired. Sign in again.",
                too_many_attempts: "Too many attempts. Try again later.",
                default: "Couldn't sign in.",
            },
        },

        processing: {
            paused: "Stopped",
            active: "Running",
            resumeTitle: "Start processing",
            pauseTitle: "Stop processing",
        },

        storage: {
            label: "Storage",
            current: "current",
            original: "original",
        },

        // Titles for the combined top-of-dashboard summary widgets
        widgets: {
            files: "Files",
            workers: "Workers",
        },

        // Status badge labels for file and job statuses
        statuses: {
            all: "All",
            queued: "Queued",
            processing: "Processing",
            transcoded: "Transcoded",
            replaced: "Replaced",
            failed: "Failed",
            rejected: "Rejected",
            stopped: "Stopped",
            ignored: "Ignored",
            pending: "Pending",
            running: "Running",
            done: "Done",
            idle: "Idle",
            busy: "Busy",
            _unknown: "Unknown",
        },

        workers: {
            empty: "No workers connected",
            emptyHint: "Runners appear here once they connect to the monitor.",
            awaitingMetrics: "Awaiting metrics…",
            cpu: "CPU",
            memory: "Memory",
            gpu: "GPU",
            cores: "Cores",
            load: "Load (1m)",
            uptime: "Uptime",
            platform: "Platform",
            version: "Version",
            connected: "Connected",
            progress: "Progress",
            paused: "Paused",
            pause: "Pause",
            resume: "Resume",
        },

        // Job type display names
        jobTypes: {
            SCAN_DIRECTORY: "Scan",
            PROBE_FILE: "Probe",
            TRANSCODE_FILE: "Transcode",
        },

        // Summary stat card labels
        statCardLabels: {
            total: "Total",
            queued: "Queued",
            processing: "Processing",
            done: "Done",
        },

        // Output mode labels keyed by value
        outputModes: {
            adjacent: "Adjacent (prefix/suffix)",
            overwrite: "Overwrite in place",
        },

        // Post-transcode filter names and descriptions
        filters: {
            "accept-minimal-size": {
                name: "Accept Minimal Size",
                description: "Rejects if output is the same size or larger than the original",
            },
            "same-file": {
                name: "Same File",
                description: "Rejects if output is byte-identical to the original (useful to catch no-op encodes)",
            },
        },

        dashboard: {
            noFiles: "No files found.",
            noJobs: "No jobs yet.",
            noTranscodes: "No completed transcodes yet.",
            loading: "Loading…",
            loadError: "Couldn't load the dashboard. Check the service and try again.",
            staleWarning: "Live updates failed. Showing the last successful dashboard snapshot.",
            ambiguousAction:
                "The request ended without confirmation. Current state was refreshed; it was not replayed.",
            ambiguousActionRefreshFailed:
                "The request ended without confirmation and current state couldn't be refreshed. Refresh before acting again.",
            ambiguousScanBlocked:
                "The outcome is unknown. Scan is disabled until this dashboard lifecycle is restarted.",
            pauseReconciliationRequired:
                "The outcome is unknown. Processing stays disabled until current dashboard state is refreshed.",
            actionErrors: {
                scan: "Couldn't start the scan.",
                processing: "Couldn't update processing.",
                workerPause: "Couldn't update the worker.",
                delete: "Couldn't delete the file.",
                deleteOutput: "Couldn't delete the output.",
                replace: "Couldn't replace the original.",
                stop: "Couldn't stop the file.",
                requeue: "Couldn't requeue the file.",
                default: "The action failed.",
            },
            showing: (n, total) => `Showing ${n} of ${total}`,
            fileCount: (n) => `${n} file${n !== 1 ? "s" : ""}`,
            replacements: (n) => `before ${n} replacement${n !== 1 ? "s" : ""}`,
            acrossFiles: (n) => `across ${n} file${n !== 1 ? "s" : ""}`,
            pctReduction: (pct) => `${pct}% reduction`,
            pctIncrease: (pct) => `${pct}% increase`,
        },

        files: {
            colFile: "File",
            colStatus: "Status",
            colSize: "Size",
            colAdded: "Added",
            colDuration: "Duration",
            colActions: "Actions",

            stopTitle: "Stop",
            requeueTitle: "Requeue",
            deleteTitle: "Delete file",
            replaceTitle: (settingName) => `Replace original with ${settingName} output`,
            deleteOutputTitle: "Delete output file",

            stopConfirmTitle: "Stop processing?",
            stopConfirmMsg: (fileName) => `Stop "${fileName}"? It will be moved to the stopped list.`,
            deleteConfirmTitle: "Delete file?",
            deleteConfirmMsg: (fileName) =>
                `Permanently delete "${fileName}" from disk and remove it from the library?`,
            replaceConfirmTitle: "Replace original?",
            replaceConfirmMsg: (fileName, settingName) =>
                `Replace "${fileName}" with the "${settingName}" output? The original file will be overwritten.`,
            deleteOutputConfirmTitle: "Delete output file?",
            deleteOutputConfirmMsg: (outputName) => `Permanently delete the output file "${outputName}" from disk?`,

            detailAdded: "Added",
            detailStarted: "Transcode started",
            detailCompleted: "Transcode completed",
            detailInputSize: "Input size",
            detailOutputSize: "Output size",
            detailOutputPath: "Output path",
            detailNoOutput: "No output file",
            detailNotStarted: "Not started",
        },

        jobs: {
            colDateTime: "Date / Time",
            colType: "Type",
            colStatus: "Status",
            colProgress: "Progress",
            colCreated: "Created",
            colError: "Error",

            detailId: "Job ID",
            detailProgress: "Progress",
            detailError: "Error",
            detailCreated: "Created",
        },

        stats: {
            currentStorage: "Current Storage",
            originalStorage: "Original Storage",
            savedStorage: "Saved Storage",
            colFile: "File",
            colSetting: "Setting",
            colOriginal: "Original",
            colOutput: "Output",
            colSaved: "Saved",
            colCompleted: "Completed",
        },

        settings: {
            generalTitle: "General",
            transcodeTitle: "Transcode Settings",
            transcodeDesc: "Files matching multiple settings are processed by all, in priority order.",
            noSettings: "No transcode settings yet. Click Add to create one.",
            editTitle: "Edit Setting",
            newTitle: "New Transcode Setting",
            languageLabel: "Language",

            // Shown when a save is rejected by the backend. Keyed by the getResult `output` code from
            // validation/settings.js; `saveError` is the fallback for any unrecognised code.
            loadError: "Couldn't load settings. Check the service and try again.",
            pauseError: "Couldn't confirm the processing update.",
            scanError: "Couldn't start the scan.",
            ambiguousScan: "The outcome is unknown. Check scan results before starting another scan.",
            ambiguousMutation: "The request ended without confirmation; current server state was reloaded.",
            ambiguousMutationRefreshFailed:
                "The request ended without confirmation and current state couldn't be reloaded. Retry reloads without saving.",
            pauseReconciliationRequired:
                "The outcome is unknown. Processing stays disabled until current state is refreshed.",
            saveError: "Couldn't save settings — please check your input.",
            saveErrors: {
                invalid_settings: "The settings payload is invalid.",
                invalid_videoExtensions: "Video extensions must be a complete list.",
                invalid_transcodeSettings: "Transcode settings must be a complete list.",
                invalid_autoScanIntervalMinutes: "The auto-scan interval is invalid.",
                invalid_revision: "The settings version is missing.",
                invalid_fileExtensions: "A profile's file extensions are invalid.",
                invalid_filters: "A profile's filters are invalid.",
                settings_conflict: "Settings changed on the server. The latest version was loaded; try again.",
                invalid_setting: "One of the transcode profiles is invalid.",
                invalid_settingId: "A transcode profile is missing its identifier.",
                invalid_name: "A transcode profile needs a name.",
                invalid_flags: "A profile uses an ffmpeg flag that isn't allowed.",
                invalid_matchPattern: "A profile's path filter isn't a valid pattern.",
                invalid_prefix: "A profile's filename prefix has invalid characters.",
                invalid_suffix: "A profile's filename suffix has invalid characters.",
                invalid_outputExtension: "A profile's output extension has invalid characters.",
            },

            enabled: "Enabled",
            disabled: "Disabled",
            enabledBadge: "enabled",
            disabledBadge: "disabled",
            defaultBadge: "default",
            enableTitle: "Click to enable",
            disableTitle: "Click to disable",

            overwriteMode: "overwrite",
            adjacentMode: "replaced in place",

            filterCount: (n) => `${n} filter${n !== 1 ? "s" : ""}`,

            fieldName: "Name",
            fieldNamePlaceholder: "Convert to HEVC",
            fieldPriority: "Priority",
            fieldPriorityHint: "(lower runs first)",
            fieldPriorityPlaceholder: "10",

            fieldExtensions: "File Extensions",
            fieldExtensionsHint: "— comma-separated, empty = all",
            fieldExtensionsPlaceholder: "mkv, mp4, avi",

            fieldPathFilter: "Path Filter",
            fieldPathFilterHint:
                "— regular expression matched against the full path with a short safety timeout. Empty = all files.",
            fieldPathFilterPlaceholder: "\\.mkv$  or  /movies/  or  leave empty",
            fieldPathFilterError: "Invalid regular expression",

            fieldFlags: "FFmpeg Flags",
            fieldFlagsHint: "— options between input and output; run as: ffmpeg -i <input> <flags> <output>",
            fieldFlagsPlaceholder: "-c:v libx265 -crf 26 -preset slow -c:a copy",

            fieldOutputMode: "Output Mode",
            fieldPrefix: "Prefix",
            fieldSuffix: "Suffix",
            fieldSuffixPlaceholder: ".hevc",
            fieldExtension: "Extension",
            fieldExtensionPlaceholder: "mkv",

            fieldFilters: "Filters",
            fieldFiltersHint: "— post-transcode checks, any match = output rejected",

            fieldOnRejection: "On Rejection",
            fieldDeleteOnReject: "Delete on reject",
            fieldDeleteOnRejectDesc:
                "Delete the output file when rejected by a filter. By default rejected outputs are kept on disk.",

            fieldVideoExtensions: "Video Extensions",
            fieldVideoExtensionsDesc: "Comma-separated",
            fieldVideoExtensionsPlaceholder: "mkv, mp4, avi",

            fieldAutoScan: "Auto-scan Interval (min)",
            fieldAutoScanDesc: "0 to disable",
        },
    },

    // ─── Español ─────────────────────────────────────────────────────────────────
    es: {
        app: { title: "Squeezarr" },

        nav: {
            dashboard: "Panel",
            settings: "Configuración",
            language: "Idioma",
        },

        tabs: {
            files: "Todos los Archivos",
            jobs: "Trabajos",
            stats: "Estadísticas",
            workers: "Workers",
        },

        actions: {
            scan: "Escanear",
            scanning: "Escaneando…",
            save: "Guardar",
            saving: "Guardando…",
            saved: "¡Guardado!",
            cancel: "Cancelar",
            confirm: "Confirmar",
            add: "Agregar",
            update: "Actualizar",
            delete: "Eliminar",
            replace: "Reemplazar",
            stop: "Detener",
            requeue: "Reencolar",
            edit: "Editar",
            retry: "Reintentar",
            refresh: "Actualizar",
            dismiss: "Descartar",
        },

        auth: {
            checking: "Verificando sesión…",
            signInTitle: "Inicie sesión para continuar",
            passwordLabel: "Contraseña",
            signIn: "Iniciar sesión",
            signingIn: "Iniciando sesión…",
            logout: "Cerrar sesión",
            unavailable: "El servicio no está disponible temporalmente. Su sesión se conservó; inténtelo de nuevo.",
            errors: {
                unauthorized: "La contraseña no funcionó.",
                expired_token: "La sesión expiró. Inicie sesión otra vez.",
                too_many_attempts: "Demasiados intentos. Intente más tarde.",
                default: "No se pudo iniciar sesión.",
            },
        },

        processing: {
            paused: "Detenido",
            active: "En ejecución",
            resumeTitle: "Iniciar procesamiento",
            pauseTitle: "Detener procesamiento",
        },

        storage: {
            label: "Almacenamiento",
            current: "actual",
            original: "original",
        },

        // Titles for the combined top-of-dashboard summary widgets
        widgets: {
            files: "Archivos",
            workers: "Workers",
        },

        statuses: {
            all: "Todos",
            queued: "En cola",
            processing: "Procesando",
            transcoded: "Transcodificado",
            replaced: "Reemplazado",
            failed: "Fallido",
            rejected: "Rechazado",
            stopped: "Detenido",
            ignored: "Ignorado",
            pending: "Pendiente",
            running: "Ejecutando",
            done: "Completado",
            idle: "Inactivo",
            busy: "Ocupado",
            _unknown: "Desconocido",
        },

        workers: {
            empty: "No hay workers conectados",
            emptyHint: "Los runners aparecen aquí cuando se conectan al monitor.",
            awaitingMetrics: "Esperando métricas…",
            cpu: "CPU",
            memory: "Memoria",
            gpu: "GPU",
            cores: "Núcleos",
            load: "Carga (1m)",
            uptime: "Tiempo activo",
            platform: "Plataforma",
            version: "Versión",
            connected: "Conectado",
            progress: "Progreso",
            paused: "Pausado",
            pause: "Pausar",
            resume: "Reanudar",
        },

        jobTypes: {
            SCAN_DIRECTORY: "Escaneo",
            PROBE_FILE: "Análisis",
            TRANSCODE_FILE: "Transcodificación",
        },

        statCardLabels: {
            total: "Total",
            queued: "En cola",
            processing: "Procesando",
            done: "Completado",
        },

        outputModes: {
            adjacent: "Adyacente (prefijo/sufijo)",
            overwrite: "Sobreescribir en sitio",
        },

        filters: {
            "accept-minimal-size": {
                name: "Tamaño Mínimo",
                description: "Rechaza si la salida es del mismo tamaño o mayor que el original",
            },
            "same-file": {
                name: "Archivo Idéntico",
                description:
                    "Rechaza si la salida es byte por byte idéntica al original (útil para detectar codificaciones sin cambio)",
            },
        },

        dashboard: {
            noFiles: "No se encontraron archivos.",
            noJobs: "No hay trabajos aún.",
            noTranscodes: "No hay transcodificaciones completadas aún.",
            loading: "Cargando…",
            loadError: "No se pudo cargar el panel. Revise el servicio e inténtelo de nuevo.",
            staleWarning: "Fallaron las actualizaciones. Se muestra la última copia correcta del panel.",
            ambiguousAction:
                "La solicitud terminó sin confirmación. Se actualizó el estado actual y no se repitió la acción.",
            ambiguousActionRefreshFailed:
                "La solicitud terminó sin confirmación y no se pudo actualizar el estado. Actualice antes de actuar otra vez.",
            ambiguousScanBlocked:
                "El resultado es incierto. El escaneo queda deshabilitado hasta reiniciar este ciclo del panel.",
            pauseReconciliationRequired:
                "El resultado es incierto. El procesamiento queda deshabilitado hasta actualizar el estado actual del panel.",
            actionErrors: {
                scan: "No se pudo iniciar el escaneo.",
                processing: "No se pudo actualizar el procesamiento.",
                workerPause: "No se pudo actualizar el worker.",
                delete: "No se pudo eliminar el archivo.",
                deleteOutput: "No se pudo eliminar la salida.",
                replace: "No se pudo reemplazar el original.",
                stop: "No se pudo detener el archivo.",
                requeue: "No se pudo reencolar el archivo.",
                default: "La acción falló.",
            },
            showing: (n, total) => `Mostrando ${n} de ${total}`,
            fileCount: (n) => `${n} archivo${n !== 1 ? "s" : ""}`,
            replacements: (n) => `antes de ${n} reemplazo${n !== 1 ? "s" : ""}`,
            acrossFiles: (n) => `en ${n} archivo${n !== 1 ? "s" : ""}`,
            pctReduction: (pct) => `${pct}% de reducción`,
            pctIncrease: (pct) => `${pct}% de aumento`,
        },

        files: {
            colFile: "Archivo",
            colStatus: "Estado",
            colSize: "Tamaño",
            colAdded: "Agregado",
            colDuration: "Duración",
            colActions: "Acciones",

            stopTitle: "Detener",
            requeueTitle: "Reencolar",
            deleteTitle: "Eliminar archivo",
            replaceTitle: (settingName) => `Reemplazar original con la salida de ${settingName}`,
            deleteOutputTitle: "Eliminar archivo de salida",

            stopConfirmTitle: "¿Detener procesamiento?",
            stopConfirmMsg: (fileName) => `¿Detener "${fileName}"? Se moverá a la lista de detenidos.`,
            deleteConfirmTitle: "¿Eliminar archivo?",
            deleteConfirmMsg: (fileName) =>
                `¿Eliminar permanentemente "${fileName}" del disco y quitarlo de la biblioteca?`,
            replaceConfirmTitle: "¿Reemplazar original?",
            replaceConfirmMsg: (fileName, settingName) =>
                `¿Reemplazar "${fileName}" con la salida de "${settingName}"? El archivo original será sobreescrito.`,
            deleteOutputConfirmTitle: "¿Eliminar archivo de salida?",
            deleteOutputConfirmMsg: (outputName) =>
                `¿Eliminar permanentemente el archivo de salida "${outputName}" del disco?`,

            detailAdded: "Agregado",
            detailStarted: "Transcodificación iniciada",
            detailCompleted: "Transcodificación completada",
            detailInputSize: "Tamaño de entrada",
            detailOutputSize: "Tamaño de salida",
            detailOutputPath: "Ruta de salida",
            detailNoOutput: "Sin archivo de salida",
            detailNotStarted: "No iniciado",
        },

        jobs: {
            colDateTime: "Fecha / Hora",
            colType: "Tipo",
            colStatus: "Estado",
            colProgress: "Progreso",
            colCreated: "Creado",
            colError: "Error",

            detailId: "ID de trabajo",
            detailProgress: "Progreso",
            detailError: "Error",
            detailCreated: "Creado",
        },

        stats: {
            currentStorage: "Almacenamiento Actual",
            originalStorage: "Almacenamiento Original",
            savedStorage: "Almacenamiento Ahorrado",
            colFile: "Archivo",
            colSetting: "Configuración",
            colOriginal: "Original",
            colOutput: "Salida",
            colSaved: "Ahorrado",
            colCompleted: "Completado",
        },

        settings: {
            generalTitle: "General",
            transcodeTitle: "Configuración de Transcodificación",
            transcodeDesc:
                "Los archivos que coincidan con múltiples configuraciones son procesados por todas, en orden de prioridad.",
            noSettings: "No hay configuraciones de transcodificación. Haga clic en Agregar para crear una.",
            editTitle: "Editar Configuración",
            newTitle: "Nueva Configuración de Transcodificación",
            languageLabel: "Idioma",

            // Se muestra cuando el backend rechaza el guardado. Indexado por el código `output` de
            // validation/settings.js; `saveError` es el respaldo para cualquier código no reconocido.
            loadError: "No se pudo cargar la configuración. Revise el servicio e inténtelo de nuevo.",
            pauseError: "No se pudo confirmar la actualización del procesamiento.",
            scanError: "No se pudo iniciar el escaneo.",
            ambiguousScan: "El resultado es incierto. Revise los resultados antes de iniciar otro escaneo.",
            ambiguousMutation: "La solicitud terminó sin confirmación; se recargó el estado actual del servidor.",
            ambiguousMutationRefreshFailed:
                "La solicitud terminó sin confirmación y no se pudo recargar el estado. Reintentar recarga sin guardar.",
            pauseReconciliationRequired:
                "El resultado es incierto. El procesamiento queda deshabilitado hasta actualizar el estado actual.",
            saveError: "No se pudo guardar la configuración — revise los datos ingresados.",
            saveErrors: {
                invalid_settings: "Los datos de configuración no son válidos.",
                invalid_videoExtensions: "Las extensiones de video deben ser una lista completa.",
                invalid_transcodeSettings: "Las configuraciones deben ser una lista completa.",
                invalid_autoScanIntervalMinutes: "El intervalo de escaneo no es válido.",
                invalid_revision: "Falta la versión de la configuración.",
                invalid_fileExtensions: "Las extensiones de archivo de una configuración no son válidas.",
                invalid_filters: "Los filtros de una configuración no son válidos.",
                settings_conflict:
                    "La configuración cambió en el servidor. Se cargó la última versión; inténtelo de nuevo.",
                invalid_setting: "Una de las configuraciones de transcodificación no es válida.",
                invalid_settingId: "A una configuración de transcodificación le falta su identificador.",
                invalid_name: "Una configuración de transcodificación necesita un nombre.",
                invalid_flags: "Una configuración usa una opción de ffmpeg que no está permitida.",
                invalid_matchPattern: "El filtro de ruta de una configuración no es un patrón válido.",
                invalid_prefix: "El prefijo de nombre de archivo de una configuración tiene caracteres no válidos.",
                invalid_suffix: "El sufijo de nombre de archivo de una configuración tiene caracteres no válidos.",
                invalid_outputExtension: "La extensión de salida de una configuración tiene caracteres no válidos.",
            },

            enabled: "Habilitado",
            disabled: "Deshabilitado",
            enabledBadge: "habilitado",
            disabledBadge: "deshabilitado",
            defaultBadge: "predeterminado",
            enableTitle: "Clic para habilitar",
            disableTitle: "Clic para deshabilitar",

            overwriteMode: "sobreescribir",
            adjacentMode: "reemplazado en sitio",

            filterCount: (n) => `${n} filtro${n !== 1 ? "s" : ""}`,

            fieldName: "Nombre",
            fieldNamePlaceholder: "Convertir a HEVC",
            fieldPriority: "Prioridad",
            fieldPriorityHint: "(menor se ejecuta primero)",
            fieldPriorityPlaceholder: "10",

            fieldExtensions: "Extensiones de Archivo",
            fieldExtensionsHint: "— separadas por comas, vacío = todas",
            fieldExtensionsPlaceholder: "mkv, mp4, avi",

            fieldPathFilter: "Filtro de Ruta",
            fieldPathFilterHint:
                "— expresión regular comparada con la ruta completa con un límite de tiempo de seguridad. Vacío = todos.",
            fieldPathFilterPlaceholder: "\\.mkv$  o  /movies/  o  dejar vacío",
            fieldPathFilterError: "Expresión regular inválida",

            fieldFlags: "Opciones FFmpeg",
            fieldFlagsHint: "— opciones entre entrada y salida; se ejecuta: ffmpeg -i <entrada> <opciones> <salida>",
            fieldFlagsPlaceholder: "-c:v libx265 -crf 26 -preset slow -c:a copy",

            fieldOutputMode: "Modo de Salida",
            fieldPrefix: "Prefijo",
            fieldSuffix: "Sufijo",
            fieldSuffixPlaceholder: ".hevc",
            fieldExtension: "Extensión",
            fieldExtensionPlaceholder: "mkv",

            fieldFilters: "Filtros",
            fieldFiltersHint: "— verificaciones post-transcodificación, cualquier coincidencia = salida rechazada",

            fieldOnRejection: "Al Rechazar",
            fieldDeleteOnReject: "Eliminar al rechazar",
            fieldDeleteOnRejectDesc:
                "Elimina el archivo de salida cuando es rechazado por un filtro. Por defecto las salidas rechazadas se mantienen en disco.",

            fieldVideoExtensions: "Extensiones de Video",
            fieldVideoExtensionsDesc: "Separadas por comas",
            fieldVideoExtensionsPlaceholder: "mkv, mp4, avi",

            fieldAutoScan: "Intervalo de Escaneo Automático (min)",
            fieldAutoScanDesc: "0 para deshabilitar",
        },
    },
};
