variable "cluster_name" {
  description = "kind cluster name. Node container names derive from it."
  type        = string
  default     = "a2a-lab"
}

variable "node_image" {
  description = "kind node image, which pins the Kubernetes version."
  type        = string
  default     = "kindest/node:v1.36.1"
}

variable "cpu_worker_count" {
  description = "Workers in the general-purpose node group."
  type        = number
  default     = 2

  validation {
    condition     = var.cpu_worker_count >= 1
    error_message = "At least one CPU worker: nothing else tolerates the GPU taint."
  }
}

variable "gpu_worker_count" {
  description = <<-EOT
    Workers in the accelerator node group.

    Keep this at 1 unless you have several physical GPUs. Every kind node is a
    container on one host, so two "GPU nodes" would both be injected with the
    same card, and the scheduler would believe it has two of something it has
    one of — which is a worse lie than the simulated path.
  EOT
  type    = number
  default = 1

  validation {
    condition     = var.gpu_worker_count <= 1 || var.enable_gpu == false
    error_message = "More than one GPU node needs one physical GPU each. See NVIDIA/nvkind for multi-GPU hosts."
  }
}

variable "enable_gpu" {
  description = <<-EOT
    Inject the host GPU into the accelerator worker.

    Requires the NVIDIA Container Toolkit configured with
    accept-nvidia-visible-devices-as-volume-mounts=true — see
    docs/windows-wsl2-gpu.md. Set false to build the same node group shape with
    no hardware and take lab 30's simulated path.
  EOT
  type    = bool
  default = true
}

variable "zones" {
  description = <<-EOT
    Fake availability zones, spread across the CPU workers.

    The values are fictional; the label key topology.kubernetes.io/zone is the
    real one EKS uses, so topologySpreadConstraints written here work on EKS
    unchanged — and actually mean something locally, which they would not on a
    single-zone cluster.
  EOT
  type    = list(string)
  default = ["eu-west-1a", "eu-west-1b", "eu-west-1c"]
}

variable "cpu_instance_type" {
  description = "What the CPU nodes claim to be. Fictional value, real label key."
  type        = string
  default     = "m6i.large"
}

variable "gpu_instance_type" {
  type    = string
  default = "g5.xlarge"
}

variable "http_node_port" {
  description = "Host port mapped to the ingress NodePort."
  type        = number
  default     = 8080
}

variable "https_node_port" {
  type    = number
  default = 8443
}

variable "agentgateway_node_port" {
  description = "Second ingress, so lab 50 and lab 60 can run side by side and be compared."
  type        = number
  default     = 8081
}
