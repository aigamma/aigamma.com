# setup_icons.ps1 (fix pass)
# Writes the missing icon32.png (LANCZOS-downsampled from your icon64.png)
# and removes the unreferenced icon64.png.
# Run once from PowerShell in this folder:
#   powershell -ExecutionPolicy Bypass -File .\setup_icons.ps1
# After this runs, the icons folder contains exactly the four files
# Chrome's manifest expects: icon16, icon32, icon48, icon128.

$ErrorActionPreference = 'Stop'
$iconDir = Join-Path $PSScriptRoot 'icons'

$icon32Base64 = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAFNUlEQVR42u2WT2xUxx3HP/Nm3r71Pr/NGgMbKC0ggR1SQgzEEAxUsvElaoJoUKtKlaqeemyT5pAopwiq5lAlSk9tSKL8OUQCuTkkadMojglqpUpNRG0gqa2CLVUkAUO9xuv1vvV7M78e3tbYqUMOOdCDR3qH0ZuZ32d+8/3Nd1QhjITb2Dxuc1sBWAG47QBmaVehPLXQExGQ5atUKQ+aQ8W5L9+h56GUh1I31xQRXHOOWRxcxGLr8c3JfoDSZlkI26hlgEqh/TwLERYFFhFqtRri0iX/tMmRz+cREVR2EWXBTdBKYV0HOFCeR23yIuncNMrT/wMRrr8L7Rdw1lL7/B+4tJFlBUFrTbVaRWvNzq4uOjo7iaIiSZJw/doko2NjTExMYIyBQhhJGLWJD9J5+Ak5MiDywItzcmRA5J4fPSO+QsJimxTCqPm1SiEsSu+vP5HDJ0UeeGFWVn2jU/JBIIXWokTFkqA82Xt/j/zp3UG5Ojkl1spCcyLy76kb8tvfnZAgXxCTnUuKzoeUu3+ArQOqhbQGa3c9zMRbv8KlMXgeLEqCpA5JwKUKkUwOWmtq1Rn6+g5x6tQAQRAgInz40VlGhv9OkqZs2LCBA/sPcOhQP8YYjPI0ab1KW+d3KG68F5tY0tp1KLRRWLeJtm29TH74e0xYQiRdLBlQsiBElCJNUkqlNp599jm01iRJwokTz3P8+FPUZmsABEGezZs3c/++ffi+j4dSuNRS7j6KDjzExlwceJy0XsHTwp17vo+gWLL9JRRNYXke9blZDvX3s2XLFqy1jIwM8+STT2Ct0BoV8XMB1jlGRz/hlZdfIo7rGJc0CEprWb3jIUSgfm2cT/96knX7f0xhTZm2bf20rN3E/PRnKBOA2OURVAa5ffs9KKVoaWlhaGgIZ1NyuYhczmfTpo2IZEeltcfly5/i2bjOqm19FMrfAoHJ4beYT2Imz76JOMiXVrHm3gdJG3FWDV/asgxFUXGh1iuVCkopZqtVevbt4+zZYYaGzvDOO+9y+vQZDh7Yj4enKHcfRWlI5xpMj/2ZQnE1N8b/RmNmBoDyfUfxTA5x9hYAWS6q1RlQCqUUpVIJEUEbw+xsjY8vnOf69WsYY5olq/DC8hZW3d2PjUHw2f7T1zn49D/Z+cgf8PyQNBbu2NpDcWMXrjEHSi+zb5r3hOLChQsgQhzH9Pb2gvLQWjM8MsKePd289uorRFGRNM0E7a3Z/T2CYgmXOsChgwgvH6GDCJqpNC2GtbsfxiUJasmNd1OY1jnyhVbeH3zPS5cuopSiq2sXx4/9EsRSqUyRJPOk1qIUWGuztdf3/ASXgsg8w795kPrVS+hcHpfO44ftdD36R0ywmjU7jzDx9tOITbIsCCDqJoMIvm+Ynq7w2GO/4NTJAXI5w89+/ii9fX2cO3cOpRTd3Xuo1Wq0t5fIBQEmXN+BF8DM2F+Y+vh9dC6fpdPTzF4ZZ3pskPUHf0i0sYP2b/dz9aM38FtLKOOhfPCMLNiAtZawNWJw8D0eOvxdjh07xo4dXfT07GV/z14A5hPhypUrnPngNOfPn0OV7zogShsalc+IK5czsTVNRmxCrlimpf2bIIrGjc+Jp/6F0j7hus6v9IJczmfXzt1s7dhKoRASx3HmBaOjjE+Mo7VBBUYLgDI+nsktNR2lkDTBpfOZYLRB+QGI4Obrt3RDrTXOOebmal+oHoXxF7lhGN3RdEO3vPc3S+qLY77Oe8A5l8ED5laT/ysuWQYsg/nqF0/28HArb8IVgBWA/1+A/wD+E3dcKFX+UwAAAABJRU5ErkJggg=='

$icon32Path = Join-Path $iconDir 'icon32.png'
[IO.File]::WriteAllBytes($icon32Path, [Convert]::FromBase64String($icon32Base64))
Write-Host "wrote $icon32Path"

$icon64Path = Join-Path $iconDir 'icon64.png'
if (Test-Path $icon64Path) {
    Remove-Item $icon64Path -Force
    Write-Host "removed $icon64Path"
}

Write-Host "Done. Icons folder now has icon16, icon32, icon48, icon128."
