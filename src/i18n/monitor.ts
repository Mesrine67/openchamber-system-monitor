import { resolveLocale } from './messages.ts';

export type MonitorMessages = {
  overview: string; performance: string; storage: string; hardware: string; health: string; optimization: string; settings: string;
  healthy: string; attention: string; critical: string; unavailableState: string;
  refresh: string; pause: string; resume: string; dashboard: string; lastUpdate: string; paused: string;
  noIssues: string; issuesDetected: string; processes: string; topCpu: string; topMemory: string;
  process: string; processFilter: string; searchProcesses: string; allProcesses: string; highCpuProcesses: string; highMemoryProcesses: string;
  processScopeNotice: string; noMatchingProcesses: string; sortProcessesBy: string; processRowsShown: string;
  processInventoryCapped: string; processInventoryComplete: string;
  parentPid: string; threadCount: string;
  treeView: string; listView: string; expandProcess: string; collapseProcess: string; processDetails: string; selectedProcess: string; processNoLongerSampled: string; processState: string;
  network: string; interfaceCount: string; download: string; upload: string; battery: string; charging: string; discharging: string; full: string;
  temperature: string; frequency: string; activity: string; read: string; write: string;
  recommendation: string; openSystemSettings: string; refreshInterval: string; historyWindow: string; processLimit: string;
  alerts: string; modules: string; warningThreshold: string; criticalThreshold: string; sustainedFor: string;
  privacy: string; readOnly: string; copyDiagnostics: string; copied: string; perCore: string; overall: string;
  free: string; used: string; fileSystem: string; device: string; computer: string; issueMemory: string;
  capacity: string; readIops: string; writeIops: string; activeTime: string; responseTime: string;
  defaultRoute: string; otherInterface: string; cached: string; committed: string; commitLimit: string;
  pressure: string; driver: string; memorySpeed: string; acConnected: string; remaining: string; batteryHealth: string;
  linkSpeed: string; motherboard: string; connected: string; disconnected: string; receivedSent: string;
  utilization: string; power: string; fanSpeed: string; route: string; dashboardMenuHint: string;
  issueDisk: string; issueCpu: string; issueGpu: string; issueSwap: string; issueBattery: string;
  storageRecommendation: string; memoryRecommendation: string; cpuRecommendation: string; noProcesses: string;
  lastTwoMinutes: string; lastFiveMinutes: string; lastFifteenMinutes: string; lastThirtyMinutes: string;
  everyTwoSeconds: string; everyFiveSeconds: string; everyTenSeconds: string; showTop5: string; showTop10: string; showTop20: string;
  wsl: string; distributions: string; wslUnavailable: string; noDistributions: string; wslVersion: string; kernelVersion: string;
  running: string; stopped: string; startDistro: string; stopDistro: string; restartDistro: string; setDefaultDistro: string;
  openTerminal: string; openFiles: string; openVscode: string; setVersion: string; setDefaultUser: string;
  shutdownAll: string; forceShutdown: string; unregisterDistro: string; confirmAction: string; confirmExact: string;
  actionInProgress: string; actionSucceeded: string; actionFailed: string; dataRemovedWarning: string;
  cancel: string; compactWarning: string; forceShutdownWarning: string; shutdownWarning: string; compactDisk: string; setVersionWarning: string;
  installDistribution: string; onlineCatalog: string; selectDistribution: string; exportDistribution: string; exportTo: string;
  importDistribution: string; importArchive: string; distroName: string; installLocation: string; versionLabel: string;
  archiveFormat: string; tarFormat: string; vhdFormat: string; vhdRequiresWsl2: string;
  importVhdInPlace: string; importVhdInPlaceHelp: string;
  moveDistro: string; resizeDisk: string; enableSparse: string; disableSparse: string; moveWarning: string; resizeWarning: string;
  operationSection: string; manageSection: string; pathPlaceholder: string; archivePlaceholder: string; usernamePlaceholder: string;
  noCatalogItems: string; loadCatalog: string;
  defaultUserWarning: string;
  globalConfig: string; distributionConfig: string; editConfig: string; saveConfig: string; configNotice: string; configSaved: string;
  pendingRestartTitle: string; pendingRestartGlobal: string; pendingRestartDistribution: string; pendingRestartStorageError: string;
  configSummary: string; configBootCommandWarning: string; configNetworkingDisabledWarning: string;
  configGuided: string; configAdvanced: string; configVmMemory: string; configVmProcessors: string; configVmSwap: string;
  configNetworkingMode: string; configSystemd: string; configAutoMount: string; configMountFstab: string;
  configDnsTunneling: string; configFirewall: string; configAutoProxy: string; configGuiApplications: string; configGpuSupport: string;
  configInterop: string; configWindowsPath: string; configNoChange: string;
  runningCount: string; defaultWslVersion: string; setDefaultWslVersion: string; updateWsl: string; updateWslWarning: string; defaultVersionWarning: string;
  searchDistributions: string; stateFilter: string; versionFilter: string; allDistributions: string; runningFilter: string; stoppedFilter: string; noFilteredDistributions: string;
  sourceFilter: string; source: string; storeSource: string; importedSource: string; unknownSource: string; virtualDiskSize: string;
  vmMemory: string; wsl2Required: string; gpuSupport: string; gpuAvailable: string; gpuUnavailable: string; directXGpu: string; cudaLibrary: string; nvidiaToolkit: string; cdiSpec: string; remoteDesktop: string;
  cloneDistro: string; renameDistro: string; cloneName: string; cloneLocation: string; cloneWarning: string; renameWarning: string; defaultDistro: string; cpuPerDistroUnavailable: string;
  wslDiagnostics: string; pid: string; cpu: string; memory: string; protocol: string; address: string; port: string; noListeningPorts: string; diagnosticsUnavailable: string;
  wslServices: string; wslServicesCount: string; noWslServices: string;
  wslMounts: string; wslMountSource: string; wslMountTarget: string; wslMountFileSystem: string; wslMountsUnavailable: string;
  wslAddresses: string; wslGateway: string; wslDnsServers: string; wslConfiguredMode: string; wslNetworkUnavailable: string;
  searchWslProcesses: string; sortWslProcesses: string; sortWslByCpu: string; sortWslByMemory: string; noWslProcessMatches: string; wslProcessSample: string;
  openchamber: string; workspaceActivity: string; selectProject: string; allSessions: string; activeSessions: string; waitingSessions: string; failedSessions: string;
  noProjects: string; noSessions: string; noMatchingSessions: string; sessionsPermissionRequired: string; sessionsUnavailable: string;
  sessionRunning: string; sessionRetrying: string; sessionWaitingPermission: string; sessionWaitingQuestion: string; sessionIdle: string; sessionFailed: string; sessionCompleted: string;
  archivedSession: string; openSession: string; sessionUpdated: string; sessionCoveragePartial: string; sessionObservedActivity: string;
  sessionFilter: string; searchSessions: string;
};

const en: MonitorMessages = {
  overview: 'Overview', performance: 'Performance', storage: 'Storage', hardware: 'Hardware', health: 'Health', optimization: 'Optimization', settings: 'Settings',
  healthy: 'Healthy', attention: 'Attention', critical: 'Critical', unavailableState: 'Unavailable',
  refresh: 'Refresh', pause: 'Pause', resume: 'Resume', dashboard: 'Full dashboard', lastUpdate: 'Updated', paused: 'Monitoring paused',
  noIssues: 'No issues detected', issuesDetected: '{n} issues detected', processes: 'Processes', topCpu: 'Top CPU', topMemory: 'Top memory',
  process: 'Process', processFilter: 'Filter processes', searchProcesses: 'Search name or PID', allProcesses: 'All sampled processes', highCpuProcesses: 'CPU ≥ 5%', highMemoryProcesses: 'Memory ≥ 512 MB',
  processScopeNotice: 'Search and sort a PID-ordered inventory of up to 500 processes. No process command lines or paths are collected.', noMatchingProcesses: 'No sampled process matches these filters.', sortProcessesBy: 'Sort by {column}', processRowsShown: '{count} matching processes.', processInventoryCapped: 'Showing a bounded sample of {count} from {total} detected processes.', processInventoryComplete: '{total} processes detected.', parentPid: 'Parent', threadCount: 'threads',
  treeView: 'Tree view', listView: 'List view', expandProcess: 'Expand children of {name}', collapseProcess: 'Collapse children of {name}', processDetails: 'Process details', selectedProcess: 'Selected process', processNoLongerSampled: 'This process is no longer in the current sample.', processState: 'State',
  network: 'Network', interfaceCount: 'Interfaces: {n}', download: 'Download', upload: 'Upload', battery: 'Battery', charging: 'Charging', discharging: 'Discharging', full: 'Full',
  temperature: 'Temperature', frequency: 'Frequency', activity: 'Activity', read: 'Read', write: 'Write',
  recommendation: 'Recommendation', openSystemSettings: 'Open Storage settings', refreshInterval: 'Refresh interval', historyWindow: 'History window', processLimit: 'Process list size',
  alerts: 'Alert thresholds', modules: 'Data modules', warningThreshold: 'Warning at', criticalThreshold: 'Critical at', sustainedFor: 'Sustained for',
  privacy: 'Privacy', readOnly: 'Monitoring is local and read-only. No telemetry is sent.', copyDiagnostics: 'Copy diagnostics', copied: 'Diagnostics copied', perCore: 'Per core', overall: 'Overall',
  free: 'Free', used: 'Used', fileSystem: 'File system', device: 'Device', computer: 'Computer', issueMemory: 'Memory usage is high',
  capacity: 'Capacity', readIops: 'Read IOPS', writeIops: 'Write IOPS', activeTime: 'Active time', responseTime: 'Response time',
  defaultRoute: 'Default route', otherInterface: 'Other interface', cached: 'Cached', committed: 'Committed', commitLimit: 'Commit limit',
  pressure: 'Memory pressure', driver: 'Driver', memorySpeed: 'Memory speed', acConnected: 'AC power', remaining: 'Remaining time', batteryHealth: 'Battery health',
  linkSpeed: 'Link speed', motherboard: 'Motherboard', connected: 'Connected', disconnected: 'Disconnected', receivedSent: 'Received / sent',
  utilization: 'Utilization', power: 'Power', fanSpeed: 'Fan speed', route: 'Route', dashboardMenuHint: 'Open System Monitor from the Extensions pages menu to view the full dashboard.',
  issueDisk: '{target} is almost full', issueCpu: 'CPU load has stayed high', issueGpu: 'GPU load has stayed high', issueSwap: 'Swap usage is high', issueBattery: 'Battery health is reduced',
  storageRecommendation: 'Review large files or open the operating system storage settings.', memoryRecommendation: 'Check the top memory processes before closing anything.', cpuRecommendation: 'Check the top CPU processes and whether the load is expected.', noProcesses: 'Process details are unavailable on this system.',
  lastTwoMinutes: 'Last 2 minutes', lastFiveMinutes: 'Last 5 minutes', lastFifteenMinutes: 'Last 15 minutes', lastThirtyMinutes: 'Last 30 minutes',
  everyTwoSeconds: 'Every 2 seconds', everyFiveSeconds: 'Every 5 seconds', everyTenSeconds: 'Every 10 seconds', showTop5: 'Top 5', showTop10: 'Top 10', showTop20: 'Top 20',
  wsl: 'WSL', distributions: 'Distributions', wslUnavailable: 'WSL is not available on the OpenChamber service host.', noDistributions: 'No WSL distributions are installed.',
  wslVersion: 'WSL version', kernelVersion: 'Kernel version', running: 'Running', stopped: 'Stopped', startDistro: 'Start', stopDistro: 'Stop',
  restartDistro: 'Restart', setDefaultDistro: 'Set default', openTerminal: 'Open terminal', openFiles: 'Open files', openVscode: 'Open in VS Code',
  setVersion: 'Set WSL version', setDefaultUser: 'Default user', shutdownAll: 'Shut down all', forceShutdown: 'Force shutdown',
  unregisterDistro: 'Unregister', confirmAction: 'Confirm action', confirmExact: 'Type exactly: {value}', actionInProgress: 'Working…',
  actionSucceeded: 'Action completed', actionFailed: 'Action failed', dataRemovedWarning: 'This permanently deletes the distribution and its files.',
  cancel: 'Cancel', compactWarning: 'The virtual disk for {distro} will be compacted after WSL shuts down.',
  forceShutdownWarning: 'WSL stops immediately, even if an operation is running. Work in progress may lose data.',
  shutdownWarning: 'All running WSL distributions will be stopped.', compactDisk: 'Compact virtual disk',
  setVersionWarning: 'Converting a distribution can take a long time and may fail. Back up important files before changing its WSL version.',
  installDistribution: 'Install distribution', onlineCatalog: 'Online catalog', selectDistribution: 'Select a distribution', exportDistribution: 'Export distribution', exportTo: 'Export archive to',
  importDistribution: 'Import distribution', importArchive: 'Import archive', distroName: 'New distribution name', installLocation: 'Installation folder', versionLabel: 'WSL version',
  archiveFormat: 'Archive format', tarFormat: 'TAR archive', vhdFormat: 'VHDX (WSL 2)', vhdRequiresWsl2: 'VHDX import requires WSL 2.',
  importVhdInPlace: 'Register an existing VHDX', importVhdInPlaceHelp: 'The VHDX must use ext4. WSL registers this file directly; it does not copy it.',
  moveDistro: 'Move distribution', resizeDisk: 'Resize virtual disk', enableSparse: 'Enable sparse mode', disableSparse: 'Disable sparse mode',
  moveWarning: 'This moves {distro} to another folder and may take several minutes. Ensure WSL has enough free space at the destination.',
  resizeWarning: 'This stops all WSL distributions before changing the virtual disk size for {distro}.',
  operationSection: 'Distribution operations', manageSection: 'Manage distribution', pathPlaceholder: 'For example: D:\\WSL\\Ubuntu', archivePlaceholder: 'For example: D:\\Backups\\Ubuntu.tar', usernamePlaceholder: 'Linux username',
  noCatalogItems: 'The online distribution list is unavailable or empty.', loadCatalog: 'Load online catalog',
  defaultUserWarning: 'This verifies the Linux user, then writes the default login to /etc/wsl.conf as root. Restart this distribution for the change to take effect.',
  globalConfig: 'Global WSL settings', distributionConfig: '{distro} settings', editConfig: 'Edit configuration', saveConfig: 'Save configuration',
  configNotice: 'Configuration can affect startup, networking, file access, or root-run boot commands. Save only settings you understand. Changes may require a full WSL shutdown.',
  configSaved: 'WSL configuration saved. Restart WSL or the affected distribution to apply it.',
  pendingRestartTitle: 'Changes waiting for restart', pendingRestartGlobal: 'Global settings need a full WSL shutdown to take effect.', pendingRestartDistribution: '{distro} settings will apply the next time this distribution starts.', pendingRestartStorageError: 'Could not persist the pending WSL restart notice.',
  configSummary: 'Detected settings', configBootCommandWarning: 'This configuration runs a command as root when the distribution starts. Review it before saving.',
  configNetworkingDisabledWarning: 'Networking is explicitly disabled for the WSL 2 virtual machine.',
  configGuided: 'Guided settings', configAdvanced: 'Advanced configuration text', configVmMemory: 'WSL 2 memory limit (for example 8GB)',
  configVmProcessors: 'WSL 2 logical processors', configVmSwap: 'WSL 2 swap size (for example 4GB)', configNetworkingMode: 'WSL 2 networking mode',
  configDnsTunneling: 'DNS tunneling', configFirewall: 'Windows Firewall integration', configAutoProxy: 'Use Windows proxy settings', configGuiApplications: 'WSLg Linux GUI applications', configGpuSupport: 'GPU support for Linux applications',
  configSystemd: 'Enable systemd', configAutoMount: 'Automatically mount Windows drives', configMountFstab: 'Process /etc/fstab at startup',
  configInterop: 'Allow launching Windows processes', configWindowsPath: 'Add Windows paths to Linux PATH', configNoChange: 'No change',
  runningCount: '{running} running of {total} distributions', defaultWslVersion: 'Default WSL version', setDefaultWslVersion: 'Set default version to WSL {version}',
  updateWsl: 'Update WSL', updateWslWarning: 'This downloads and installs the current WSL package. Running distributions may need to be restarted.',
  defaultVersionWarning: 'This changes the WSL version used for newly installed distributions. Existing distributions are not converted.',
  searchDistributions: 'Search distributions', stateFilter: 'Status', versionFilter: 'WSL version', allDistributions: 'All', runningFilter: 'Running', stoppedFilter: 'Stopped', noFilteredDistributions: 'No distributions match these filters.',
  sourceFilter: 'Source', source: 'Source', storeSource: 'Microsoft Store', importedSource: 'Imported', unknownSource: 'Unknown', virtualDiskSize: 'Virtual disk file',
  vmMemory: 'Shared WSL VM memory', wsl2Required: 'This operation requires a WSL 2 distribution.', gpuSupport: 'WSL GPU support', gpuAvailable: 'Available', gpuUnavailable: 'Not available', directXGpu: 'DirectX GPU device', cudaLibrary: 'NVIDIA CUDA library', nvidiaToolkit: 'NVIDIA Container Toolkit', cdiSpec: 'NVIDIA CDI spec', remoteDesktop: 'Open xrdp desktop',
  cloneDistro: 'Clone distribution', renameDistro: 'Rename distribution', cloneName: 'Clone name', cloneLocation: 'Clone installation folder', cloneWarning: 'This exports the source distribution and imports a copy under a new name. It can require substantial free disk space and may take a long time.', renameWarning: 'This creates and verifies a full copy under the new name, then unregisters the original. Keep enough free disk space. If removal fails, both distributions remain available.',
  defaultDistro: 'Default distribution', cpuPerDistroUnavailable: 'WSL does not expose reliable CPU usage per distribution.',
  wslDiagnostics: 'Processes and listening ports', pid: 'PID', cpu: 'CPU', memory: 'Memory', protocol: 'Protocol', address: 'Address', port: 'Port', noListeningPorts: 'No listening ports detected.', diagnosticsUnavailable: 'Diagnostics unavailable.',
  wslServices: 'System services', wslServicesCount: '{count} services', noWslServices: 'No system services reported by systemd.',
  wslMounts: 'Mounted filesystems', wslMountSource: 'Source', wslMountTarget: 'Mount point', wslMountFileSystem: 'Filesystem', wslMountsUnavailable: 'Mount data is unavailable in this distribution.',
  wslAddresses: 'Distribution addresses', wslGateway: 'Default gateway', wslDnsServers: 'DNS servers', wslConfiguredMode: 'Configured network mode', wslNetworkUnavailable: 'Guest network details are unavailable; required Linux tools may be missing.',
  searchWslProcesses: 'Search process name or PID', sortWslProcesses: 'Sort processes', sortWslByCpu: 'CPU usage', sortWslByMemory: 'Memory usage', noWslProcessMatches: 'No WSL process matches this search.', wslProcessSample: 'Sample combines up to 100 processes ranked by CPU and 100 ranked by memory. CPU is guest process usage; distribution-level CPU is not exposed reliably.',
  openchamber: 'OpenChamber', workspaceActivity: 'Session activity', selectProject: 'Project', allSessions: 'All sessions', activeSessions: 'Active', waitingSessions: 'Waiting', failedSessions: 'Failed',
  noProjects: 'No OpenChamber projects are available on this server.', noSessions: 'No sessions are available for this project.', noMatchingSessions: 'No sessions match this filter.', sessionsPermissionRequired: 'Approve the Sessions capability for this extension in OpenChamber, then reopen this page.', sessionsUnavailable: 'OpenChamber session activity is unavailable.',
  sessionRunning: 'Running', sessionRetrying: 'Retrying', sessionWaitingPermission: 'Waiting for permission', sessionWaitingQuestion: 'Waiting for your answer', sessionIdle: 'Idle', sessionFailed: 'Last run failed', sessionCompleted: 'Last run completed',
  archivedSession: 'Archived', openSession: 'Open session', sessionUpdated: 'Updated', sessionCoveragePartial: 'Some project sessions may still be loading.', sessionObservedActivity: 'Shows session activity reported by OpenChamber; it does not identify process ownership or expose terminal output.',
  sessionFilter: 'Filter sessions', searchSessions: 'Search session titles',
};

const fr: MonitorMessages = {
  overview: 'Vue d’ensemble', performance: 'Performances', storage: 'Stockage', hardware: 'Matériel', health: 'Santé', optimization: 'Optimisation', settings: 'Réglages',
  healthy: 'Sain', attention: 'À surveiller', critical: 'Critique', unavailableState: 'Indisponible',
  refresh: 'Actualiser', pause: 'Mettre en pause', resume: 'Reprendre', dashboard: 'Tableau de bord complet', lastUpdate: 'Mis à jour', paused: 'Surveillance en pause',
  noIssues: 'Aucun problème détecté', issuesDetected: '{n} problèmes détectés', processes: 'Processus', topCpu: 'Plus forte utilisation CPU', topMemory: 'Plus forte utilisation mémoire',
  process: 'Processus', processFilter: 'Filtrer les processus', searchProcesses: 'Rechercher par nom ou PID', allProcesses: 'Tous les processus échantillonnés', highCpuProcesses: 'CPU ≥ 5 %', highMemoryProcesses: 'Mémoire ≥ 512 Mo',
  processScopeNotice: 'Recherche et tri dans un inventaire ordonné par PID, limité à 500 processus. Aucune ligne de commande ni aucun chemin de processus ne sont collectés.', noMatchingProcesses: 'Aucun processus échantillonné ne correspond aux filtres.', sortProcessesBy: 'Trier par {column}', processRowsShown: '{count} processus correspondent.', processInventoryCapped: 'Échantillon limité à {count} processus sur {total} détectés.', processInventoryComplete: '{total} processus détectés.', parentPid: 'Parent', threadCount: 'threads',
  treeView: 'Vue arborescente', listView: 'Vue en liste', expandProcess: 'Développer les enfants de {name}', collapseProcess: 'Réduire les enfants de {name}', processDetails: 'Détails du processus', selectedProcess: 'Processus sélectionné', processNoLongerSampled: 'Ce processus ne figure plus dans l’échantillon actuel.', processState: 'État',
  network: 'Réseau', interfaceCount: 'Interfaces réseau : {n}', download: 'Téléchargement', upload: 'Envoi', battery: 'Batterie', charging: 'En charge', discharging: 'En décharge', full: 'Chargée',
  temperature: 'Température', frequency: 'Fréquence', activity: 'Activité', read: 'Lecture', write: 'Écriture',
  recommendation: 'Conseil', openSystemSettings: 'Ouvrir les paramètres de stockage', refreshInterval: 'Fréquence d’actualisation', historyWindow: 'Période de l’historique', processLimit: 'Nombre de processus',
  alerts: 'Seuils d’alerte', modules: 'Modules de données', warningThreshold: 'Avertissement à', criticalThreshold: 'Critique à', sustainedFor: 'Durée minimale',
  privacy: 'Confidentialité', readOnly: 'La surveillance est locale et en lecture seule. Aucune télémétrie n’est envoyée.', copyDiagnostics: 'Copier le diagnostic', copied: 'Diagnostic copié', perCore: 'Par cœur', overall: 'Global',
  free: 'Libre', used: 'Utilisé', fileSystem: 'Système de fichiers', device: 'Périphérique', computer: 'Ordinateur', issueMemory: 'Utilisation mémoire élevée',
  capacity: 'Capacité', readIops: 'IOPS en lecture', writeIops: 'IOPS en écriture', activeTime: 'Temps actif', responseTime: 'Temps de réponse',
  defaultRoute: 'Route par défaut', otherInterface: 'Autre interface', cached: 'En cache', committed: 'Engagée', commitLimit: 'Limite d’engagement',
  pressure: 'Pression mémoire', driver: 'Pilote', memorySpeed: 'Vitesse mémoire', acConnected: 'Alimentation secteur', remaining: 'Temps restant', batteryHealth: 'Santé de la batterie',
  linkSpeed: 'Débit de liaison', motherboard: 'Carte mère', connected: 'Branché', disconnected: 'Débranché', receivedSent: 'Reçu / envoyé',
  utilization: 'Utilisation', power: 'Puissance', fanSpeed: 'Vitesse du ventilateur', route: 'Route', dashboardMenuHint: 'Ouvre System Monitor depuis le menu des pages d’extensions pour afficher le tableau de bord complet.',
  issueDisk: '{target} est presque plein', issueCpu: 'La charge CPU reste élevée', issueGpu: 'La charge GPU reste élevée', issueSwap: 'Utilisation du swap élevée', issueBattery: 'La santé de la batterie est réduite',
  storageRecommendation: 'Examine les gros fichiers ou ouvre les paramètres de stockage du système.', memoryRecommendation: 'Consulte les processus qui utilisent le plus de mémoire avant d’en fermer un.', cpuRecommendation: 'Vérifie les processus les plus actifs et si cette charge est attendue.', noProcesses: 'Les détails des processus ne sont pas disponibles sur ce système.',
  lastTwoMinutes: '2 dernières minutes', lastFiveMinutes: '5 dernières minutes', lastFifteenMinutes: '15 dernières minutes', lastThirtyMinutes: '30 dernières minutes',
  everyTwoSeconds: 'Toutes les 2 secondes', everyFiveSeconds: 'Toutes les 5 secondes', everyTenSeconds: 'Toutes les 10 secondes', showTop5: 'Top 5', showTop10: 'Top 10', showTop20: 'Top 20',
  wsl: 'WSL', distributions: 'Distributions', wslUnavailable: 'WSL est indisponible sur la machine qui héberge le service OpenChamber.', noDistributions: 'Aucune distribution WSL installée.',
  wslVersion: 'Version de WSL', kernelVersion: 'Version du noyau', running: 'En cours', stopped: 'Arrêtée', startDistro: 'Démarrer', stopDistro: 'Arrêter',
  restartDistro: 'Redémarrer', setDefaultDistro: 'Définir par défaut', openTerminal: 'Ouvrir le terminal', openFiles: 'Ouvrir les fichiers', openVscode: 'Ouvrir dans VS Code',
  setVersion: 'Définir la version WSL', setDefaultUser: 'Utilisateur par défaut', shutdownAll: 'Arrêter tout WSL', forceShutdown: 'Forcer l’arrêt',
  unregisterDistro: 'Désinscrire', confirmAction: 'Confirmer l’action', confirmExact: 'Saisis exactement : {value}', actionInProgress: 'Opération en cours…',
  actionSucceeded: 'Action terminée', actionFailed: 'Échec de l’action', dataRemovedWarning: 'Cette action supprime définitivement la distribution et ses fichiers.',
  cancel: 'Annuler', compactWarning: 'Le disque virtuel de {distro} sera compacté après l’arrêt de WSL.',
  forceShutdownWarning: 'WSL s’arrête même si une opération est en cours. Le travail en cours peut perdre des données.',
  shutdownWarning: 'Toutes les distributions WSL en cours seront arrêtées.', compactDisk: 'Compacter le disque virtuel',
  setVersionWarning: 'La conversion peut prendre du temps ou échouer. Sauvegarde les fichiers importants avant de changer la version WSL.',
  installDistribution: 'Installer une distribution', onlineCatalog: 'Catalogue en ligne', selectDistribution: 'Choisir une distribution', exportDistribution: 'Exporter la distribution', exportTo: 'Exporter l’archive vers',
  importDistribution: 'Importer une distribution', importArchive: 'Archive à importer', distroName: 'Nom de la nouvelle distribution', installLocation: 'Dossier d’installation', versionLabel: 'Version WSL',
  archiveFormat: 'Format d’archive', tarFormat: 'Archive TAR', vhdFormat: 'VHDX (WSL 2)', vhdRequiresWsl2: 'L’import VHDX nécessite WSL 2.',
  importVhdInPlace: 'Enregistrer un VHDX existant', importVhdInPlaceHelp: 'Le VHDX doit être au format ext4. WSL enregistre ce fichier directement, sans le copier.',
  moveDistro: 'Déplacer la distribution', resizeDisk: 'Redimensionner le disque virtuel', enableSparse: 'Activer le mode sparse', disableSparse: 'Désactiver le mode sparse',
  moveWarning: 'Cette opération déplace {distro} vers un autre dossier et peut durer plusieurs minutes. Vérifie l’espace libre à destination.',
  resizeWarning: 'Cette opération arrête toutes les distributions WSL avant de modifier la taille du disque virtuel de {distro}.',
  operationSection: 'Opérations sur les distributions', manageSection: 'Gérer la distribution', pathPlaceholder: 'Par exemple : D:\\WSL\\Ubuntu', archivePlaceholder: 'Par exemple : D:\\Sauvegardes\\Ubuntu.tar', usernamePlaceholder: 'Nom d’utilisateur Linux',
  noCatalogItems: 'La liste des distributions en ligne est indisponible ou vide.', loadCatalog: 'Charger le catalogue en ligne',
  defaultUserWarning: 'Cette action vérifie l’utilisateur Linux puis écrit le compte par défaut dans /etc/wsl.conf en tant que root. Redémarre cette distribution pour appliquer le changement.',
  globalConfig: 'Réglages globaux WSL', distributionConfig: 'Réglages de {distro}', editConfig: 'Modifier la configuration', saveConfig: 'Enregistrer la configuration',
  configNotice: 'La configuration peut modifier le démarrage, le réseau, l’accès aux fichiers ou exécuter des commandes en root au lancement. N’enregistre que des réglages que tu comprends. Un arrêt complet de WSL peut être nécessaire pour appliquer les changements.',
  configSaved: 'Configuration WSL enregistrée. Redémarre WSL ou la distribution concernée pour appliquer les changements.',
  pendingRestartTitle: 'Modifications en attente de redémarrage', pendingRestartGlobal: 'Les réglages globaux seront appliqués après un arrêt complet de WSL.', pendingRestartDistribution: 'Les réglages de {distro} seront appliqués à son prochain démarrage.', pendingRestartStorageError: 'Impossible d’enregistrer l’avis de redémarrage WSL en attente.',
  configSummary: 'Réglages détectés', configBootCommandWarning: 'Cette configuration exécute une commande en tant que root au démarrage de la distribution. Vérifie-la avant l’enregistrement.',
  configNetworkingDisabledWarning: 'Le réseau est explicitement désactivé pour la machine virtuelle WSL 2.',
  configGuided: 'Réglages guidés', configAdvanced: 'Configuration texte avancée', configVmMemory: 'Limite mémoire WSL 2 (exemple : 8GB)',
  configVmProcessors: 'Nombre de processeurs logiques WSL 2', configVmSwap: 'Taille du swap WSL 2 (exemple : 4GB)', configNetworkingMode: 'Mode réseau WSL 2',
  configDnsTunneling: 'Tunnel DNS', configFirewall: 'Intégration du pare-feu Windows', configAutoProxy: 'Utiliser le proxy Windows', configGuiApplications: 'Applications Linux graphiques via WSLg', configGpuSupport: 'Prise en charge GPU pour les applications Linux',
  configSystemd: 'Activer systemd', configAutoMount: 'Monter automatiquement les lecteurs Windows', configMountFstab: 'Traiter /etc/fstab au démarrage',
  configInterop: 'Autoriser le lancement des processus Windows', configWindowsPath: 'Ajouter les chemins Windows au PATH Linux', configNoChange: 'Ne pas modifier',
  runningCount: '{running} en cours sur {total} distributions', defaultWslVersion: 'Version WSL par défaut', setDefaultWslVersion: 'Définir la version par défaut sur WSL {version}',
  updateWsl: 'Mettre WSL à jour', updateWslWarning: 'Cette action télécharge et installe le paquet WSL actuel. Les distributions en cours peuvent devoir être redémarrées.',
  defaultVersionWarning: 'Ce réglage s’applique aux prochaines installations. Il ne convertit pas les distributions existantes.',
  searchDistributions: 'Rechercher une distribution', stateFilter: 'État', versionFilter: 'Version WSL', allDistributions: 'Toutes', runningFilter: 'En cours', stoppedFilter: 'Arrêtées', noFilteredDistributions: 'Aucune distribution ne correspond à ces filtres.',
  sourceFilter: 'Source', source: 'Source', storeSource: 'Microsoft Store', importedSource: 'Importée', unknownSource: 'Inconnue', virtualDiskSize: 'Fichier du disque virtuel',
  vmMemory: 'Mémoire de la VM WSL (partagée)', wsl2Required: 'Cette opération nécessite une distribution WSL 2.', gpuSupport: 'Prise en charge GPU WSL', gpuAvailable: 'Disponible', gpuUnavailable: 'Indisponible', directXGpu: 'Périphérique GPU DirectX', cudaLibrary: 'Bibliothèque NVIDIA CUDA', nvidiaToolkit: 'NVIDIA Container Toolkit', cdiSpec: 'Spécification NVIDIA CDI', remoteDesktop: 'Ouvrir le bureau xrdp',
  cloneDistro: 'Cloner la distribution', renameDistro: 'Renommer la distribution', cloneName: 'Nom de la copie', cloneLocation: 'Dossier d’installation de la copie', cloneWarning: 'La distribution source sera exportée puis importée sous un nouveau nom. L’opération peut demander beaucoup d’espace disque et durer longtemps.', renameWarning: 'Une copie complète sera créée et vérifiée avant la désinscription de l’originale. Prévois assez d’espace libre. En cas d’échec de suppression, les deux distributions restent disponibles.',
  defaultDistro: 'Distribution par défaut', cpuPerDistroUnavailable: 'WSL ne fournit pas de mesure CPU fiable pour chaque distribution.',
  wslDiagnostics: 'Processus et ports en écoute', pid: 'PID', cpu: 'CPU', memory: 'Mémoire', protocol: 'Protocole', address: 'Adresse', port: 'Port', noListeningPorts: 'Aucun port en écoute détecté.', diagnosticsUnavailable: 'Diagnostic indisponible.',
  wslServices: 'Services système', wslServicesCount: '{count} services', noWslServices: 'Aucun service système signalé par systemd.',
  wslMounts: 'Systèmes de fichiers montés', wslMountSource: 'Source', wslMountTarget: 'Point de montage', wslMountFileSystem: 'Système de fichiers', wslMountsUnavailable: 'Les montages ne sont pas disponibles dans cette distribution.',
  wslAddresses: 'Adresses de la distribution', wslGateway: 'Passerelle par défaut', wslDnsServers: 'Serveurs DNS', wslConfiguredMode: 'Mode réseau configuré', wslNetworkUnavailable: 'Les informations réseau de l’invité sont indisponibles ; des outils Linux requis sont peut-être absents.',
  searchWslProcesses: 'Rechercher un processus ou un PID', sortWslProcesses: 'Trier les processus', sortWslByCpu: 'Utilisation CPU', sortWslByMemory: 'Utilisation mémoire', noWslProcessMatches: 'Aucun processus WSL ne correspond à cette recherche.', wslProcessSample: 'Échantillon combinant jusqu’à 100 processus classés par CPU et 100 par mémoire. Le CPU est mesuré dans l’invité ; la consommation CPU par distribution reste indisponible de façon fiable.',
  openchamber: 'OpenChamber', workspaceActivity: 'Activité des sessions', selectProject: 'Projet', allSessions: 'Toutes les sessions', activeSessions: 'Actives', waitingSessions: 'En attente', failedSessions: 'En échec',
  noProjects: 'Aucun projet OpenChamber n’est disponible sur ce serveur.', noSessions: 'Aucune session disponible pour ce projet.', noMatchingSessions: 'Aucune session ne correspond à ce filtre.', sessionsPermissionRequired: 'Autorise la capacité Sessions pour cette extension dans OpenChamber, puis rouvre cette page.', sessionsUnavailable: 'L’activité des sessions OpenChamber est indisponible.',
  sessionRunning: 'En cours', sessionRetrying: 'Nouvel essai', sessionWaitingPermission: 'En attente d’une autorisation', sessionWaitingQuestion: 'En attente de ta réponse', sessionIdle: 'Inactive', sessionFailed: 'Dernière exécution en échec', sessionCompleted: 'Dernière exécution terminée',
  archivedSession: 'Archivée', openSession: 'Ouvrir la session', sessionUpdated: 'Mise à jour', sessionCoveragePartial: 'Certaines sessions du projet sont peut-être encore en cours de chargement.', sessionObservedActivity: 'Affiche l’activité fournie par OpenChamber ; cette vue n’attribue pas de processus et ne révèle pas la sortie des terminaux.',
  sessionFilter: 'Filtrer les sessions', searchSessions: 'Rechercher dans les titres des sessions',
};

const partial: Partial<Record<string, Partial<MonitorMessages>>> = {
  de: { overview: 'Übersicht', performance: 'Leistung', storage: 'Speicher', hardware: 'Hardware', health: 'Systemzustand', optimization: 'Optimierung', settings: 'Einstellungen', healthy: 'In Ordnung', attention: 'Achtung', critical: 'Kritisch', refresh: 'Aktualisieren', pause: 'Pausieren', resume: 'Fortsetzen', dashboard: 'Vollständiges Dashboard', processes: 'Prozesse', network: 'Netzwerk', interfaceCount: 'Schnittstellen: {n}', battery: 'Akku', temperature: 'Temperatur', copyDiagnostics: 'Diagnose kopieren' },
  es: { overview: 'Resumen', performance: 'Rendimiento', storage: 'Almacenamiento', hardware: 'Hardware', health: 'Estado', optimization: 'Optimización', settings: 'Ajustes', healthy: 'Correcto', attention: 'Atención', critical: 'Crítico', refresh: 'Actualizar', pause: 'Pausar', resume: 'Reanudar', dashboard: 'Panel completo', processes: 'Procesos', network: 'Red', interfaceCount: 'Interfaces: {n}', battery: 'Batería', temperature: 'Temperatura', copyDiagnostics: 'Copiar diagnóstico' },
  ja: { overview: '概要', performance: 'パフォーマンス', storage: 'ストレージ', hardware: 'ハードウェア', health: '状態', optimization: '最適化', settings: '設定', healthy: '正常', attention: '注意', critical: '重大', refresh: '更新', pause: '一時停止', resume: '再開', dashboard: '全画面ダッシュボード', processes: 'プロセス', network: 'ネットワーク', interfaceCount: 'インターフェース数: {n}', battery: 'バッテリー', temperature: '温度', copyDiagnostics: '診断情報をコピー' },
  ko: { overview: '개요', performance: '성능', storage: '저장소', hardware: '하드웨어', health: '상태', optimization: '최적화', settings: '설정', healthy: '정상', attention: '주의', critical: '위험', refresh: '새로 고침', pause: '일시 중지', resume: '재개', dashboard: '전체 대시보드', processes: '프로세스', network: '네트워크', interfaceCount: '인터페이스 수: {n}', battery: '배터리', temperature: '온도', copyDiagnostics: '진단 복사' },
  nl: { overview: 'Overzicht', performance: 'Prestaties', storage: 'Opslag', hardware: 'Hardware', health: 'Status', optimization: 'Optimalisatie', settings: 'Instellingen', healthy: 'Goed', attention: 'Let op', critical: 'Kritiek', refresh: 'Vernieuwen', pause: 'Pauzeren', resume: 'Hervatten', dashboard: 'Volledig dashboard', processes: 'Processen', network: 'Netwerk', interfaceCount: 'Interfaces: {n}', battery: 'Accu', temperature: 'Temperatuur', copyDiagnostics: 'Diagnose kopiëren' },
  pl: { overview: 'Przegląd', performance: 'Wydajność', storage: 'Pamięć masowa', hardware: 'Sprzęt', health: 'Stan', optimization: 'Optymalizacja', settings: 'Ustawienia', healthy: 'Dobrze', attention: 'Uwaga', critical: 'Krytyczny', refresh: 'Odśwież', pause: 'Wstrzymaj', resume: 'Wznów', dashboard: 'Pełny pulpit', processes: 'Procesy', network: 'Sieć', interfaceCount: 'Interfejsy: {n}', battery: 'Bateria', temperature: 'Temperatura', copyDiagnostics: 'Kopiuj diagnostykę' },
  'pt-BR': { overview: 'Visão geral', performance: 'Desempenho', storage: 'Armazenamento', hardware: 'Hardware', health: 'Integridade', optimization: 'Otimização', settings: 'Configurações', healthy: 'Saudável', attention: 'Atenção', critical: 'Crítico', refresh: 'Atualizar', pause: 'Pausar', resume: 'Retomar', dashboard: 'Painel completo', processes: 'Processos', network: 'Rede', interfaceCount: 'Interfaces: {n}', battery: 'Bateria', temperature: 'Temperatura', copyDiagnostics: 'Copiar diagnóstico' },
  tr: { overview: 'Genel bakış', performance: 'Performans', storage: 'Depolama', hardware: 'Donanım', health: 'Durum', optimization: 'Optimizasyon', settings: 'Ayarlar', healthy: 'Sağlıklı', attention: 'Dikkat', critical: 'Kritik', refresh: 'Yenile', pause: 'Duraklat', resume: 'Sürdür', dashboard: 'Tam pano', processes: 'İşlemler', network: 'Ağ', interfaceCount: 'Arayüz sayısı: {n}', battery: 'Pil', temperature: 'Sıcaklık', copyDiagnostics: 'Tanılamayı kopyala' },
  uk: { overview: 'Огляд', performance: 'Продуктивність', storage: 'Сховище', hardware: 'Обладнання', health: 'Стан', optimization: 'Оптимізація', settings: 'Налаштування', healthy: 'Норма', attention: 'Увага', critical: 'Критично', refresh: 'Оновити', pause: 'Призупинити', resume: 'Відновити', dashboard: 'Повна панель', processes: 'Процеси', network: 'Мережа', interfaceCount: 'Інтерфейси: {n}', battery: 'Батарея', temperature: 'Температура', copyDiagnostics: 'Копіювати діагностику' },
  'zh-CN': { overview: '概览', performance: '性能', storage: '存储', hardware: '硬件', health: '健康状态', optimization: '优化', settings: '设置', healthy: '正常', attention: '注意', critical: '严重', refresh: '刷新', pause: '暂停', resume: '继续', dashboard: '完整仪表板', processes: '进程', network: '网络', interfaceCount: '网络接口数：{n}', battery: '电池', temperature: '温度', copyDiagnostics: '复制诊断信息' },
  'zh-TW': { overview: '概覽', performance: '效能', storage: '儲存空間', hardware: '硬體', health: '健康狀態', optimization: '最佳化', settings: '設定', healthy: '正常', attention: '注意', critical: '嚴重', refresh: '重新整理', pause: '暫停', resume: '繼續', dashboard: '完整儀表板', processes: '處理程序', network: '網路', interfaceCount: '網路介面數：{n}', battery: '電池', temperature: '溫度', copyDiagnostics: '複製診斷資訊' },
};

export const monitorMessagesFor = (tag: string): MonitorMessages => {
  const locale = resolveLocale(tag);
  return { ...en, ...partial[locale], ...(locale === 'fr' ? fr : {}) };
};
