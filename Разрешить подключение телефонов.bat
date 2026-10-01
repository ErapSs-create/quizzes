@echo off
chcp 65001 >nul
net session >nul 2>&1
if errorlevel 1 (
  echo Нужны права администратора: щёлкните по файлу правой кнопкой и выберите "Запуск от имени администратора".
  pause
  exit /b
)
netsh advfirewall firewall delete rule name="Викторины (порты 3000-3001)" >nul 2>&1
netsh advfirewall firewall add rule name="Викторины (порты 3000-3001)" dir=in action=allow protocol=TCP localport=3000-3001 profile=any
echo.
echo Готово: телефоны теперь могут подключаться к викторинам.
pause
