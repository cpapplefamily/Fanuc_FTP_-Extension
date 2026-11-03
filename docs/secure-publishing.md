# Secure Visual Studio Marketplace publishing

This repository publishes through Azure Pipelines using Microsoft Entra workload identity federation. No Personal Access Token is stored in the repository or pipeline.

This follows the official [secure automated publishing guidance](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace).

## One-time Azure and Marketplace setup

1. In Azure DevOps, create an Azure Resource Manager service connection using **Workload Identity Federation (manual)**. Name it `robot-ftp-marketplace` and initially save it as a draft.
2. In Azure, create a user-assigned managed identity, assign it the **Reader** role, and record its client ID, tenant ID, subscription ID, and subscription name.
3. Exchange the federation values:
   - Copy the issuer and subject from the draft Azure DevOps service connection into a federated credential on the managed identity.
   - Copy the Azure client, tenant, and subscription values into the Azure DevOps service connection, then verify and save it.
4. Grant the release pipeline permission to use the service connection.
5. Run the following once inside an `AzureCLI@2` task using that service connection and record the returned `id` value:

   ```powershell
   az rest -u https://app.vssps.visualstudio.com/_apis/profile/profiles/me --resource 499b84ac-1321-427f-aa17-267ca6975798
   ```

6. In Visual Studio Marketplace publisher management, add that managed identity resource ID as a member of the `CoreyApplegate` publisher and grant it the **Contributor** role.
7. Create an Azure Pipeline from `azure-pipelines.yml`. Confirm its `azureServiceConnection` variable matches the service connection name.

## Publishing a release

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md` to the final release version.
2. Commit and push the release changes.
3. Create and push a matching `v` tag, such as `v0.5.0` for package version `0.5.0`.
4. The pipeline installs dependencies, runs lint and snippet tests, verifies the tag matches `package.json`, creates a VSIX pipeline artifact, and publishes it with `vsce publish --azure-credential`.

The pipeline can also be run manually. A tag-triggered run is preferred because it verifies the release version.
