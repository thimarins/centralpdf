param(
  [Parameter(Mandatory = $true)][string]$InputPath,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security.Cryptography.Pkcs

$rsa = [System.Security.Cryptography.RSA]::Create(2048)
$certificate = $null
try {
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
    'CN=Central PDF Automated Test',
    $rsa,
    [System.Security.Cryptography.HashAlgorithmName]::SHA256,
    [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
  )
  $certificate = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddDays(1))
  $content = [System.Security.Cryptography.Pkcs.ContentInfo]::new([System.IO.File]::ReadAllBytes($InputPath))
  $signedCms = [System.Security.Cryptography.Pkcs.SignedCms]::new($content, $true)
  $signer = [System.Security.Cryptography.Pkcs.CmsSigner]::new($certificate)
  $signer.DigestAlgorithm = [System.Security.Cryptography.Oid]::new('2.16.840.1.101.3.4.2.1')
  $signedCms.ComputeSignature($signer)

  # Verify the detached CMS with its embedded test certificate. This validates
  # the CMS cryptography, not the certificate's trust or production identity.
  $verification = [System.Security.Cryptography.Pkcs.SignedCms]::new($content, $true)
  $encoded = $signedCms.Encode()
  $verification.Decode($encoded)
  $verification.CheckSignature($true)
  [System.IO.File]::WriteAllBytes($OutputPath, $encoded)
} finally {
  if ($certificate) { $certificate.Dispose() }
  $rsa.Dispose()
}
