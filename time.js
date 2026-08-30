export function getLocalTime() {
  const now = new Date();
  
  // המרה לאזור הזמן של ישראל
  const israelTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  
  // פונקציית עזר להוספת אפס מוביל (למשל 9 הופך ל-09)
  const pad = (n) => n.toString().padStart(2, '0');
  
  // החזרת הזמן בפורמט YYYY-MM-DD HH:MM:SS
  return `${israelTime.getFullYear()}-${pad(israelTime.getMonth() + 1)}-${pad(israelTime.getDate())} ${pad(israelTime.getHours())}:${pad(israelTime.getMinutes())}:${pad(israelTime.getSeconds())}`;
}
