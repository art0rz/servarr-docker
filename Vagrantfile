# frozen_string_literal: true

Vagrant.configure("2") do |config|
  config.vm.box = "ubuntu/jammy64"
  config.vm.hostname = "servarr-dev"

  # Forward the health dashboard port so it is reachable on the host.
  # Forward key container ports so dashboards are reachable from the host.
  config.vm.network "forwarded_port", guest: 3000, host: 33000, auto_correct: true  # health dashboard
  config.vm.network "forwarded_port", guest: 6767, host: 36767, auto_correct: true  # Bazarr
  config.vm.network "forwarded_port", guest: 7878, host: 37878, auto_correct: true  # Radarr
  config.vm.network "forwarded_port", guest: 8989, host: 38989, auto_correct: true  # Sonarr
  config.vm.network "forwarded_port", guest: 9696, host: 39696, auto_correct: true  # Prowlarr
  config.vm.network "forwarded_port", guest: 8080, host: 38080, auto_correct: true  # qBittorrent (gluetun)

  # Share the repo into the VM. rsync keeps host performance high and avoids Docker bind mount issues.
  config.vm.synced_folder ".", "/home/vagrant/servarr", type: "rsync",
                         rsync__exclude: [".git/", "config/", "logs/"],
                         owner: "vagrant", group: "vagrant"

  config.vm.provider "virtualbox" do |vb|
    vb.memory = 4096
    vb.cpus = 2
  end

  config.vm.provision "shell", privileged: false, inline: <<-SHELL
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive

    sudo apt-get update -y
    sudo apt-get install -y \
      ca-certificates \
      curl \
      python3 \
      python3-venv \
      python3-pip \
      git \
      jq \
      unzip

    # Install Docker Engine + compose plugin if missing.
    if ! command -v docker >/dev/null 2>&1; then
      sudo install -m 0755 -d /etc/apt/keyrings
      curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --yes --dearmor -o /etc/apt/keyrings/docker.gpg
      echo \
        "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
        $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
      sudo apt-get update -y
      sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      sudo usermod -aG docker vagrant
    fi

    # Install Vagrant helper dependencies
    if ! command -v pipx >/dev/null 2>&1; then
      python3 -m pip install --user pipx
      ~/.local/bin/pipx ensurepath
    fi

    cd /home/vagrant/servarr
    # Ensure git safe directory so local edits are allowed inside VM
    git config --global --add safe.directory /home/vagrant/servarr

    echo "Bootstrap VM ready. Run 'vagrant ssh' to enter."
  SHELL
end
