import { resolveLocale } from './messages.ts';

export type MonitorMessages = {
  overview: string; performance: string; storage: string; hardware: string; health: string; optimization: string; settings: string;
  healthy: string; attention: string; critical: string; unavailableState: string;
  refresh: string; pause: string; resume: string; dashboard: string; lastUpdate: string; paused: string;
  noIssues: string; issuesDetected: string; processes: string; topCpu: string; topMemory: string;
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
};

const en: MonitorMessages = {
  overview: 'Overview', performance: 'Performance', storage: 'Storage', hardware: 'Hardware', health: 'Health', optimization: 'Optimization', settings: 'Settings',
  healthy: 'Healthy', attention: 'Attention', critical: 'Critical', unavailableState: 'Unavailable',
  refresh: 'Refresh', pause: 'Pause', resume: 'Resume', dashboard: 'Full dashboard', lastUpdate: 'Updated', paused: 'Monitoring paused',
  noIssues: 'No issues detected', issuesDetected: '{n} issues detected', processes: 'Processes', topCpu: 'Top CPU', topMemory: 'Top memory',
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
};

const fr: MonitorMessages = {
  overview: 'Vue d’ensemble', performance: 'Performances', storage: 'Stockage', hardware: 'Matériel', health: 'Santé', optimization: 'Optimisation', settings: 'Réglages',
  healthy: 'Sain', attention: 'À surveiller', critical: 'Critique', unavailableState: 'Indisponible',
  refresh: 'Actualiser', pause: 'Mettre en pause', resume: 'Reprendre', dashboard: 'Tableau de bord complet', lastUpdate: 'Mis à jour', paused: 'Surveillance en pause',
  noIssues: 'Aucun problème détecté', issuesDetected: '{n} problèmes détectés', processes: 'Processus', topCpu: 'Plus forte utilisation CPU', topMemory: 'Plus forte utilisation mémoire',
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
